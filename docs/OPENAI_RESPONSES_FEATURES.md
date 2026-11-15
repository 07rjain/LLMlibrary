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

## Switching Models And Providers

Inspect the library's adapter support before enabling a control in your UI:

```ts
const support = client.models.getResponseCapabilities(selectedModel);
// { pdfInput: boolean, verbosity: boolean, reasoningSummary: boolean }
```

This resolves registered lifecycle redirects first. It describes completion
adapter coverage based on the model's registered provider, kind, vision flag,
and compatible OpenAI model family; provider/account restrictions still apply.
Custom OpenAI aliases need compatible family names to use these response controls.
`reasoningSummary` refers to the canonical non-streaming summary field. Gemini's
thought stream and Anthropic's thinking controls have separate contracts.

Reusing OpenAI verbosity or reasoning options with an incompatible model throws
`ProviderCapabilityError` before sending that attempt. This includes switching to
Gemini or Anthropic, and using reasoning controls on non-reasoning OpenAI models.
The error's `details.unsupported` lists the affected option paths.

To let users switch models while accepting the loss of these optional controls:

```ts
await client.complete({
  model: selectedModel,
  messages, // including any canonical PDF document parts
  providerOptions: {
    unsupportedFeaturePolicy: 'omit',
    openai: { verbosity: 'low', reasoning: { summary: 'auto' } },
  },
});
```

The default policy is `error`. `omit` removes only unsupported OpenAI verbosity
and reasoning settings from the translated attempt, without mutating the caller's
request. Supported settings remain: for example, switching to `o3` omits verbosity
but retains reasoning. On a non-reasoning OpenAI model it removes the entire
reasoning configuration, including effort and encrypted-content requests.
Structured output and independently configured native provider settings remain.
There is no automatic conversion from OpenAI verbosity or summaries into another
provider's thinking options. Configure those explicitly in `google` or `anthropic`
when needed. This policy does not normalize every legacy provider-specific option.

PDFs remain message content under either policy. They use each selected provider's
native document translation, require a vision-capable model, and remain subject to
that provider's file formats, URL handling, and limits. Unsupported inputs reject;
`omit` never removes documents or other message parts to make a request succeed.
Inline PDF data is the most portable form; a URL accepted by one provider is not a
guarantee that another provider can retrieve it.

The same policy applies to `complete()`, `stream()`, conversation sends, and restored
snapshots. Fallback checks run only when an attempt is dispatched, so an unused
incompatible fallback does not invalidate a compatible primary. A strict-policy
capability error stops the request; it does not trigger another automatic fallback.
With `omit`, a fallback triggered by an eligible provider failure can proceed using
the selected provider's supported controls. Existing restrictions on fallback after
stream output still apply.

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
