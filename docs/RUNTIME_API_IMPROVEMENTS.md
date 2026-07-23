# Runtime API Improvements

This page documents the six focused runtime improvements being delivered as independent pull requests. They are generic LLMlibrary APIs and are intentionally reviewable and releasable separately.

## 1. Request Metadata And Request IDs

Completion and streaming requests accept:

```ts
{
  requestId?: string;
  metadata?: Record<string, JsonValue>;
}
```

The values are provider-neutral and are copied into `UsageEvent` records. Use them to correlate usage, warnings, failures, retries, and product-level requests without adding provider-specific fields.

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

The current live baseline passes OpenAI and Anthropic. Gemini currently reports two known conformance failures: streaming may return no text, and forced tool calls may finish with `length` instead of `tool_call`. These failures remain visible so release validation cannot silently claim full provider parity.

## Pull Requests

The implementation is split into focused pull requests:

- Metadata and request IDs
- Request cost quotes
- External tool dispatch
- Per-step context policy
- Versioned stream events
- Live provider conformance

Each implementation includes its own tests and API documentation. This page is the consolidated reference for the complete six-feature set.
