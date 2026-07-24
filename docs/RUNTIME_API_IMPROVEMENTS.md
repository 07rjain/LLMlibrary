# Runtime API Improvements

This page documents the focused runtime improvements currently included in main. They are generic LLMlibrary APIs and are intentionally reviewable and releasable separately. Request-level metadata from PR #12 is intentionally excluded.

## 1. Request IDs

Completion and streaming requests accept:

```ts
{
  requestId?: string;
}
```

The request ID is copied to v2 stream events. Request-level metadata and UsageEvent propagation remain outside this release; PR #12 is intentionally excluded.

## 2. Request Cost Quotes

`client.estimateRequest(options)` estimates a completion before dispatch:

```ts
const quote = client.estimateRequest({
  maxTokens: 512,
  messages: [{ role: 'user', content: 'Summarize this.' }],
});
```

The returned `RequestCostEstimate` includes input tokens, maximum output tokens, reasoning tokens, estimated USD cost, model, provider, and `priceVersion`. Budget preflight uses the same calculation.

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

Context management runs before the initial request and each automatic tool-loop follow-up. Context strategies receive the current tool round, request ID, reserved output capacity, context-window information when configured, and an estimated tool-schema allowance.

Use `ConversationOptions.onCompaction` to observe removed or summarized messages:

```ts
const conversation = await client.conversation({
  onCompaction: (event) => recordCompaction(event),
});
```

## 5. Versioned Stream Events

`client.stream()` emits canonical stream events with `version: 2`, monotonic `sequence`, an emission timestamp, and the request ID when supplied.

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
- Request cost quotes
- External tool dispatch
- Per-step context policy
- Versioned stream events
- Live provider conformance

Each implementation includes focused tests and API documentation.
