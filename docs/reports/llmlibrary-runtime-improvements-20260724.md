# LLMlibrary Runtime Improvement Context

**Date:** 2026-07-24
**Base revision:** `cfd1957fd315e4962fef8283ce3acf855a5482a9`
**Package:** `unified-llm-client@0.1.8`

## Scope

LLMlibrary should remain a reusable, provider-neutral model runtime. The next changes should strengthen its public request, tool, context, streaming, usage, and provider-conformance APIs without adding product-specific orchestration or policy.

The changes below are related at the API-contract level, but each implementation should land in a separate pull request so that it can be reviewed, tested, and released independently.

## Generic Runtime Improvements

### 1. Request Metadata And Request IDs

Add `requestId?: string` and `metadata?: Record<string, JsonValue>` to model request options.

Propagate these values into:

- usage events
- warning callbacks
- wrapped request errors
- stream completion metadata
- retry and fallback diagnostics

The metadata map must remain provider-neutral and must not add product-specific fields to the core request type.

### 2. External Tool Call Dispatcher

Add an optional dispatcher for applications that need to own tool execution:

```ts
interface ToolCallDispatcher {
  execute(input: {
    call: CanonicalToolCall;
    model: string;
    provider: CanonicalProvider;
    sessionId?: string;
    signal: AbortSignal;
    metadata?: Record<string, JsonValue>;
  }): Promise<JsonValue>;
}
```

When provided, `Conversation` should route tool calls through the dispatcher. The existing inline `tool.execute()` path should remain available for trusted integrations and tests.

The dispatcher is an execution boundary, not a permission system. Approval, sandboxing, audit logging, artifact storage, and application-specific policy remain the caller's responsibility.

### 3. Request Cost Quote API

Expose a quote API that estimates cost without sending a request:

```ts
interface RequestCostEstimate {
  inputTokens: number;
  maxOutputTokens: number;
  reasoningTokens: number;
  estimatedCostUSD: number;
  model: string;
  provider: CanonicalProvider;
  priceVersion: string;
}

client.estimateRequest(options): RequestCostEstimate;
```

The quote should use the same model registry, tokenizer estimate, pricing data, and output-token assumptions as budget preflight. Every quote should identify the pricing snapshot used.

Existing `budgetUsd` behavior can remain as local defense in depth. Shared or transactional accounting belongs to the consuming application.

### 4. Context Policy Before Every Model Step

Run context management before every model request, including automatic tool-loop follow-up requests, not only before the initial user turn.

Extend the context-manager input with model-step information:

```ts
{
  requestId: string;
  toolRound: number;
  contextWindow: number;
  reservedOutputTokens: number;
  estimatedToolSchemaTokens: number;
}
```

Add a callback describing removed, pruned, or summarized content so integrations can persist compaction records or artifact references.

The library should preserve complete tool-call and tool-result pairs whenever it trims history.

### 5. Versioned Canonical Stream Events

Version the stream event contract before consumers depend on it.

Add provider-neutral events for:

- response start
- reasoning start, delta, and end where available
- usage updates before completion
- retry and fallback attempts
- refusal or structured-output status
- stable sequence numbers
- provider request and response identifiers
- first-token timing

Raw provider payloads may remain available for diagnostics, but they should not be required for normal consumers.

### 6. Live Provider Conformance Gates

Promote live provider conformance from ad hoc evidence to an explicit release gate.

Minimum opt-in checks should cover:

- normal completion across supported provider families
- streaming and first-token timing
- cancellation behavior
- tool calls and parallel tool calls
- structured output
- retry and rate-limit classification
- actual versus estimated cost reconciliation
- context-overflow behavior
- concurrent requests under defined limits

These tests should remain opt-in for local development, while release automation should require configured credentials and publish a clear pass/fail result.

## Recommended Pull Request Boundaries

Open separate pull requests in this order:

1. Request metadata and request ID propagation.
2. `estimateRequest()` and pricing snapshot/version reporting.
3. Optional `ToolCallDispatcher`.
4. Per-step context evaluation and compaction callbacks.
5. Versioned canonical stream events.
6. Live provider conformance gates.

Each pull request should include focused unit tests, relevant integration tests, public API documentation, and any compatibility notes. Do not combine unrelated runtime contracts into a single implementation change.

## Acceptance Criteria

The runtime work is complete when:

- every model request accepts correlation metadata
- usage and stream completion can be attributed to a caller-supplied request ID
- external integrations can own tool execution through a public dispatcher
- context policy runs before every model step
- cost can be quoted without sending a request
- canonical stream events expose the lifecycle boundaries consumers need
- live provider conformance results are available before release
