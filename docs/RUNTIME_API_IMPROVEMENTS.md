# Runtime API Improvements

This page documents the focused runtime improvements currently included in main. They are generic LLMlibrary APIs and are intentionally reviewable and releasable separately.

## 1. Request IDs

Completion and streaming requests accept:

```ts
{
  requestId?: string;
}
```

The request ID is copied to v3 stream events, per-step context callbacks, provider attempts, and UsageEvents. Requests also accept JSON-safe application metadata; see [Request Metadata](./REQUEST_METADATA.md).

## 2. Request Cost Quotes

`client.estimateRequest(options)` estimates a completion before dispatch:

```ts
const quote = client.estimateRequest({
  maxTokens: 512,
  messages: [{ role: 'user', content: 'Summarize this.' }],
});
```

The returned `RequestCostEstimate` includes input tokens, maximum output tokens, reasoning tokens, estimated USD cost, model, provider, and `priceVersion`. Budget preflight uses the same calculation.
When a `ModelRouter` is configured without an explicit model, the quote uses the router's primary attempt.

## 3. External Tool Call Dispatch

`Conversation` accepts an optional `toolCallDispatcher`:

```ts
const conversation = await client.conversation({
  toolCallDispatcherMetadata: { integration: 'support-runtime' },
  toolCallDispatcher: {
    execute: async ({ call, model, provider, sessionId, signal }) => {
      return executeApplicationTool(call, { model, provider, sessionId, signal });
    },
  },
});
```

The dispatcher receives a canonical tool call and execution context. The existing inline `CanonicalTool.execute` path remains available when no dispatcher is configured. The dispatcher is an execution boundary, not a permission or sandbox policy.

## 4. Per-Step Context Policy

Context management runs before the initial request and each automatic tool-loop follow-up. The client resolves the selected model/provider before the first trim, and context strategies receive the current tool round, request ID, model context window, reserved output capacity, and estimated tool-schema allowance. The effective token budget is bounded by both the application `maxContextTokens` cap and the selected model's context window.

Use `ConversationOptions.onCompaction` to observe removed or summarized messages:

```ts
const conversation = await client.conversation({
  onCompaction: (event) => recordCompaction(event),
});
```

## 5. Versioned Stream Events

`client.stream()` emits canonical stream events with `version: 3`, monotonic `sequence`, an emission timestamp, and the request ID when supplied.

In addition to text, tool, error, and done events, consumers may receive:

- `response-start`
- `usage-update`
- `retry`
- `reasoning-start`, `reasoning-delta`, and `reasoning-end` when available
- `response-status` for refusal or structured-output state

Only `done` is terminal. Consumers should branch on `chunk.type` and forward unknown future event types safely.

## 6. Live Provider Conformance

Run the opt-in release gate with real credentials:

```bash
pnpm test:conformance:live
```

The gate checks canonical completion, streaming, usage and cost reporting, and tool-call normalization for OpenAI, Anthropic, and Google. It is disabled during ordinary local unit runs because it makes real provider requests.

The conformance gate uses provider-appropriate output budgets so Gemini thinking tokens do not consume the entire response allowance. Failures remain strict and visible so release validation cannot silently claim provider parity.

## Pull Requests

The implementation is split into focused pull requests:

- Request IDs and stream correlation
- Request metadata and UsageEvent correlation
- Request cost quotes
- External tool dispatch
- Per-step context policy
- Versioned stream events
- Live provider conformance

Each implementation includes focused tests and API documentation.
