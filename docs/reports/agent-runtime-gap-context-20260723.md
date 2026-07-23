# Agent Runtime Gap Context

**Date:** 2026-07-23  
**Base revision:** `cfd1957fd315e4962fef8283ce3acf855a5482a9`  
**Package:** `unified-llm-client@0.1.8`

## Decision

LLMlibrary should remain a reusable model-runtime library, not become a full coding-agent operating system.

The library is the right place for provider-neutral model request primitives, canonical messages, usage accounting, streaming, tool-call representation, request cost estimation, context handling, and provider conformance tests.

The agent harness should own run orchestration, permissions, sandboxing, durable event state, plugin isolation, terminal UI, hierarchical budgets, and product-specific policy.

## Why This Boundary Matters

Agent CLI and ChatForge both need stronger runtime primitives from LLMlibrary, but they do not need the same product shell.

Putting permissions, plugins, terminal rendering, multi-agent scheduling, and sandbox process control into LLMlibrary would make the package less reusable and would couple ordinary SDK users to agent-specific assumptions. The better split is to expose small generic hooks and metadata from LLMlibrary, then let each application build its own policy engine around those hooks.

## First LLMlibrary Slice

Ship the following as small generic changes before adding agent-specific behavior.

### 1. Request Metadata And Request IDs

Add `requestId?: string` and `metadata?: Record<string, JsonValue>` to model request options.

Propagate these values into:

- usage events
- warning callbacks
- thrown errors where the library wraps request failures
- stream `done` metadata
- retry and fallback diagnostics

This lets downstream systems attribute model spend and failures to a run, task, tool follow-up, compaction request, review pass, or product workflow without adding agent-specific fields to the provider library.

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

When provided, `Conversation` should route tool calls through this dispatcher. The current inline `tool.execute()` path should remain for trusted applications and tests.

The dispatcher is intentionally not a permission system. It is the seam where a harness or product backend can apply approvals, sandboxing, artifact storage, audit logging, idempotency checks, and cancellation.

### 3. Request Cost Quote API

Expose a quote API that estimates cost without sending the request:

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

This should use the same model registry, tokenizer estimate, pricing data, and output-token assumptions as the existing budget preflight path.

LLMlibrary can keep `budgetUsd` as local defense in depth. Transactional shared reservations belong in the harness or product backend.

### 4. Context Policy Before Every Model Step

Run context management before every model request, including automatic tool-loop follow-up requests, not only before the initial user turn.

Extend the context manager input with model-step context:

```ts
{
  requestId: string;
  toolRound: number;
  contextWindow: number;
  reservedOutputTokens: number;
  estimatedToolSchemaTokens: number;
}
```

Add a callback for removed, pruned, or summarized content so applications can persist compaction events and artifact references.

The library should preserve complete tool-call/tool-result pairs whenever it trims history.

### 5. Richer Canonical Stream Events

Version the stream event contract before an agent UI depends on it.

Add provider-neutral events for:

- response start
- reasoning start, delta, and end where available
- usage updates before completion
- retry and fallback attempts
- refusal or structured-output status
- stable sequence numbers
- provider request and response identifiers
- first-token timestamp

Raw provider payloads can remain available for diagnostics without becoming part of the canonical contract.

### 6. Live Provider Conformance Gates

Promote live provider conformance from ad hoc evidence to a release gate.

Minimum live checks:

- normal completion across supported provider families
- streaming and first-token timing
- cancellation behavior
- tool calls and parallel tool calls
- structured output
- retry and rate-limit classification
- actual versus estimated cost reconciliation
- context-overflow behavior
- concurrent requests under defined limits

These tests should stay opt-in for local development, but release publishing should require them with real credentials.

## Keep In The Agent CLI Harness

The following should not be added to LLMlibrary:

- agent tree and parent/child lifecycle
- durable run, agent, attempt, and event ledger
- transactional hierarchical budgets
- permission broker and approval UI
- filesystem, network, and process sandboxing
- tool process execution and cleanup
- plugin install, trust, isolation, and capability grants
- skill activation policy and enforcement
- tool-output artifacts and pruning policy
- workspace write-conflict coordination
- OpenTUI rendering
- agent-level telemetry dashboards

Those pieces are agent-product concerns. They should consume the generic LLMlibrary hooks rather than live inside the provider runtime package.

## ChatForge Context

ChatForge should use these LLMlibrary improvements, but still own product policy.

LLMlibrary can provide request metadata, cost quotes, external tool dispatch, context hooks, and canonical streaming. ChatForge should continue to own tenant authentication, public widget API keys, connector authorization, database row-level security, billing budgets, retention policy, and customer-facing audit behavior.

For ChatForge production readiness, the same runtime gaps matter, but the ownership remains product-side for anything tenant-specific or connector-specific.

## Suggested PR Order

Do not land this as one large runtime rewrite.

1. Add `requestId` and generic metadata propagation.
2. Expose `estimateRequest()` and record the pricing snapshot/version used.
3. Add optional `ToolCallDispatcher`.
4. Run context policy before every model step and emit compaction callbacks.
5. Version and extend canonical stream events.
6. Add live provider conformance gates to the release checklist.

This order gives the agent harness and ChatForge useful primitives early while keeping review scope controlled.

## Acceptance Criteria

LLMlibrary is ready to sit under an agent harness when:

- every model request accepts correlation metadata
- usage can be attributed to a caller-supplied request ID
- external systems can own tool execution through a public dispatcher
- context policy runs before every model step
- cost can be quoted without sending a request
- stream events expose lifecycle boundaries needed by a UI
- live provider conformance tests pass before release

The harness is ready for subagents only after:

- single-agent runs recover after process termination
- every tool passes through one permission and sandbox path
- event replay produces the same final projection
- budget reservations prevent concurrent overspend
- descendant cancellation terminates model and tool work
- context compaction and artifacts preserve a coherent transcript
