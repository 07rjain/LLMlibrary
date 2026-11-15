# OpenAI Responses Features

The OpenAI adapter uses `POST /v1/responses` for both completion and streaming,
with `store: false`. Conversation history remains in the library's session store.
These additions use that same transport and require no OpenAI SDK dependency.

## PDF Document Inputs

Pass a canonical `document` part in a **user** message:

```ts
const response = await client.complete({
  model: 'gpt-6.1-sol',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Summarise this report.' },
        {
          type: 'document',
          mediaType: 'application/pdf',
          url: 'https://example.com/report.pdf',
        },
      ],
    },
  ],
});
```

Alternatively, supply bare standard base64 in `data` and an optional PDF filename
in `title`. The adapter builds `file_data: 'data:application/pdf;base64,...'` and
uses `document.pdf` when no title is supplied. Supply exactly one of `data` and
`url`; URLs must use HTTPS without embedded credentials. The provider retrieves
URLs; the library does not download them. Your application should restrict which
document URLs it accepts from untrusted callers.

The adapter checks the model's vision capability, rejects other document MIME
types, and keeps document inputs out of assistant/system messages. PDFs work
through `complete()`, `stream()`, conversations, and the Session API, including
restored history. File IDs and Files API upload/lifecycle helpers are not exposed
by the canonical document type.

OpenAI limits combined files per request to 50 MB, with each file under 50 MB.
Provider limits still apply. PDF input includes extracted text and rendered page
images. Local budget estimates use the existing payload-size heuristic and do
not reproduce PDF parsing or page-image tokenization; provider-reported usage
determines the resulting token cost.

## Response Verbosity

On compatible GPT-5/GPT-6 models, choose a response detail preference:

```ts
const response = await client.complete({
  model: 'gpt-6.1-sol',
  messages: [{ role: 'user', content: 'Explain the change.' }],
  providerOptions: { openai: { verbosity: 'low' } },
});
```

Allowed values are `low`, `medium`, and `high`. The adapter maps this to
`text.verbosity` and combines it with `text.format` when `responseFormat` requests
structured output. Omitting it preserves the provider default. Invalid values
and older OpenAI model families reject before transport. Registered model IDs
must use a compatible `gpt-5...` or `gpt-6...` family name; this option does not
infer capabilities for arbitrary custom aliases.

Verbosity controls response detail rather than the token limit. Use `maxTokens`
to bound output. Conversation snapshots preserve and validate the preference.

## Provider-Authored Reasoning Summaries

Request a summary on a model that supports it:

```ts
const request = {
  model: 'gpt-6.1-sol',
  messages: [{ role: 'user' as const, content: 'Check this calculation.' }],
  providerOptions: { openai: { reasoning: { summary: 'auto' as const } } },
};

const response = await client.complete(request);
console.log(response.reasoningSummary); // optional provider-authored summary
console.log(response.text); // final answer

for await (const chunk of client.stream(request)) {
  if (chunk.type === 'reasoning-delta') console.log(chunk.delta);
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
}
```

Non-streaming summaries are joined with blank lines in `reasoningSummary`.
Empty or absent summaries leave the field unset. Streaming maps summary events
to the existing `reasoning-start`, `reasoning-delta`, and `reasoning-end` chunks.
Completed text/part events do not duplicate earlier deltas. The same events pass
through conversation streaming and the existing Session API SSE events
`response.reasoning.started`, `response.reasoning.delta`, and
`response.reasoning.completed`.

Summaries are separate from `text`, canonical answer content, and persisted
conversation messages. Raw reasoning text and encrypted content are not exposed
as summary chunks. `raw` retains the provider payload. This adds summary output
handling; it does not add encrypted reasoning replay. Existing provider usage
accounting still includes reasoning tokens without charging them twice.

## Sources And Remaining Gaps

Checked November 15, 2026 against the official [file input guide](https://developers.openai.com/api/docs/guides/file-inputs),
[Responses request reference](https://developers.openai.com/api/reference/resources/responses/methods/create),
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning), and
[streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).
Automated tests use simulated provider transport; account-specific availability
and real provider responses need credentialed smoke tests.

Further integrations remain separate work: provider-hosted search/Code Interpreter/MCP
with their tool-specific events, citations, and charges; background jobs and
Realtime transport; OpenAI embeddings; and native Gemini embedding batching.
These features need their own request, result, and accounting contracts.
