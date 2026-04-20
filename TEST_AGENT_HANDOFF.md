# Test Agent Handoff

Prepared: 2026-04-16

## Purpose

This file is for a separate testing/validation agent. Use [todo.md](/Users/rishabh/Desktop/tryandtested/chatbot101/todo.md) as the source of truth for task status, and use this handoff file as the execution guide for verification.

## Current Build Status

- The project is a TypeScript package with strict typechecking, ESLint, Vitest, and `tsup`.
- The currently implemented slices are:
  - Foundation setup and utilities: `T-01`, `T-02`, `T-04`, `T-05`, `T-06`, `T-07`
  - Model registry including the public client price-override path: `T-03`
  - Provider adapters:
    - `T-08` Anthropic complete
    - `T-09` OpenAI complete
      - transport now uses `POST /v1/responses`
      - requests are stateless with `store: false`, top-level `instructions`, and full-history `input`
      - streaming now expects Responses events such as `response.output_text.delta`, `response.function_call_arguments.delta`, `response.output_item.done`, and `response.completed`
    - `T-10` Gemini complete
  - Conversation/session core:
    - `T-11` Conversation complete
    - `T-12.1` to `T-12.6` context management complete, including summarisation coverage
    - `T-13.1` to `T-13.6` session-store baseline complete, including Redis support
    - Default `LLMClient` persistence now auto-attaches `PostgresSessionStore.fromEnv()` when `DATABASE_URL` exists and no explicit store is passed
  - Streaming/tool normalization:
    - `T-14.1` to `T-14.9` tool definition plus conversation-level auto tool execution complete
    - `T-15.1` to `T-15.6` canonical stream chunking, abort-signal support, and tool pause/execute/resume complete
    - `T-16.1` to `T-16.5` model routing, fallback chains, deterministic weighted A/B routing, and routing decision logging complete
  - Usage/cost tracking:
    - `T-17.1` to `T-17.6` usage logging, Postgres aggregation, per-call budget guards, per-session budget forwarding, `client.getUsage()`, and `client.exportUsage()` complete
  - Session API:
    - `T-19.1` to `T-19.10` session lifecycle endpoints, SSE streaming, tenant middleware, and request-context hooks complete
    - `T-20.1` to `T-20.5` Responses-style mapping documentation complete in [SESSION_API.md](/Users/rishabh/Desktop/tryandtested/chatbot101/SESSION_API.md)
  - Public client surface:
    - `T-18.1` to `T-18.6` complete, including `LLMClient.mock()`
  - Phase 7 follow-up:
    - `T-21.1` to `T-21.7` complete, including provider mock-server coverage, cross-tenant isolation tests, cost-accuracy coverage, Session API lifecycle inspection, and `LIVE_TESTS=1` live smoke tests
    - `T-22.1` to `T-22.6` complete, including JSDoc, Typedoc, release docs workflow, README docs links, provider comparison, migration guide, and changelog
    - `T-23.1` to `T-23.4` complete, including size checks and performance scripts for request overhead, first-token streaming latency, 10,000-turn memory, and 100-session concurrency
  - PRD addendum follow-up:
    - OpenAI exact token counting, explicit cancelable streams, budget breach actions, no-credential serialization/logging, Edge-safe core imports, dependency-count CI, price-staleness CI, and usage export are complete
    - Launch-scope and roadmap decisions are documented in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md), [docs/COST_AND_PRICING.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/COST_AND_PRICING.md), and [docs/ROADMAP.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/ROADMAP.md)
- The user has populated `.env` locally with API keys. Do not echo values in logs or reports.
- The user has also populated `DATABASE_URL` locally for Postgres/Neon-backed session persistence.
- Latest verified commands:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm build`
  - `pnpm sizecheck`
  - `pnpm depcheck`
  - `pnpm edgecheck`
  - `pnpm bench:complete`
  - `pnpm bench:first-token`
  - `pnpm bench:memory`
  - `pnpm bench:concurrency`
  - `pnpm pricecheck`
  - `pnpm docs:api`
  - `pnpm test:live` is available for opt-in real-provider validation when run with `LIVE_TESTS=1`
- Live smoke verified locally after export-loading `.env`:
  - Anthropic `claude-sonnet-4-6` text completion returned `OK`
  - OpenAI `gpt-4o` text completion returned `OK`
  - Gemini `gemini-2.5-flash` text completion returned `OK`
  - Postgres/Neon `PostgresSessionStore` schema/create/read/list/delete smoke passed against `DATABASE_URL`
  - End-to-end `LLMClient.fromEnv()` auto-persistence and restore smoke passed against OpenAI plus `DATABASE_URL`
  - End-to-end `PostgresUsageLogger` insert plus `client.getUsage()` aggregation smoke passed against OpenAI plus `DATABASE_URL`
- Latest verified test count and coverage:
  - `342` passing tests, plus `4` opt-in live tests skipped unless `LIVE_TESTS=1`
  - `91.81%` statements / lines
  - `86.23%` branches
  - `96.35%` functions

## Key Files

- Public API:
  - [src/index.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/index.ts)
  - [src/client.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/client.ts)
  - [src/router.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/router.ts)
  - [src/session-api.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/session-api.ts)
  - [src/tools.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/tools.ts)
  - [src/usage.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/usage.ts)
- Conversation and session state:
  - [src/conversation.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/conversation.ts)
  - [src/context-manager.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/context-manager.ts)
  - [src/session-store.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/session-store.ts)
- Providers:
  - [src/providers/anthropic.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/providers/anthropic.ts)
  - [src/providers/gemini.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/providers/gemini.ts)
  - [src/providers/openai.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/providers/openai.ts)
- Core model/types/utilities:
  - [src/types.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/types.ts)
  - [src/models/registry.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/models/registry.ts)
  - [src/utils](/Users/rishabh/Desktop/tryandtested/chatbot101/src/utils)
- Tests:
  - [test/anthropic.adapter.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/anthropic.adapter.test.ts)
  - [test/gemini.adapter.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/gemini.adapter.test.ts)
  - [test/openai.adapter.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/openai.adapter.test.ts)
  - [test/client.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/client.test.ts)
  - [test/conversation.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/conversation.test.ts)
  - [test/postgres-session-store.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/postgres-session-store.test.ts)
  - [test/redis-session-store.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/redis-session-store.test.ts)
  - [test/router.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/router.test.ts)
  - [test/session-api.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/session-api.test.ts)
  - [test/provider-mock-server.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/provider-mock-server.test.ts)
  - [test/live.e2e.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/live.e2e.test.ts)
  - [test/tools.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/tools.test.ts)
  - [test/usage.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/usage.test.ts)
  - plus the utility/model tests under [test](/Users/rishabh/Desktop/tryandtested/chatbot101/test)
- Docs and perf tooling:
  - [docs/PROVIDER_COMPARISON.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PROVIDER_COMPARISON.md)
  - [docs/MIGRATION_GUIDE.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/MIGRATION_GUIDE.md)
  - [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)
  - [docs/COST_AND_PRICING.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/COST_AND_PRICING.md)
  - [docs/ROADMAP.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/ROADMAP.md)
  - [CHANGELOG.md](/Users/rishabh/Desktop/tryandtested/chatbot101/CHANGELOG.md)
  - [scripts/check-bundle-size.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/check-bundle-size.mjs)
  - [scripts/check-runtime-deps.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/check-runtime-deps.mjs)
  - [scripts/check-edge-compat.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/check-edge-compat.mjs)
  - [scripts/check-price-staleness.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/check-price-staleness.mjs)
  - [scripts/benchmark-complete-overhead.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/benchmark-complete-overhead.mjs)
  - [scripts/benchmark-first-token-latency.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/benchmark-first-token-latency.mjs)
  - [scripts/check-conversation-memory.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/check-conversation-memory.mjs)
  - [scripts/check-concurrent-sessions.mjs](/Users/rishabh/Desktop/tryandtested/chatbot101/scripts/check-concurrent-sessions.mjs)

## Required Commands

Run these first:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm sizecheck
pnpm depcheck
pnpm edgecheck
pnpm bench:complete
pnpm bench:first-token
pnpm bench:memory
pnpm bench:concurrency
pnpm pricecheck
pnpm docs:api
```

## Live Smoke Test Checklist

Only run these after the user fills `.env`.

### Anthropic

- Instantiate `LLMClient` with `ANTHROPIC_API_KEY`
- Send a simple text completion against `claude-sonnet-4-6`
- Send a tool-calling request with one function
- Send a streaming request and verify `text-delta` and `done`
- Confirm typed failures on bad key / deliberate invalid payload

### OpenAI

- Instantiate `LLMClient` with `OPENAI_API_KEY`
- Send a simple text completion against `gpt-4o`
- Send a multimodal request with `image_url`
- Send a tool-calling request and verify function args are parsed from JSON strings
- Confirm the request body uses `input` plus `store: false`, with no `conversation` or `previous_response_id`
- Send a streaming request and verify:
  - `response.output_text.delta` is surfaced as canonical `text-delta`
  - tool-call delta reassembly from Responses events still works
  - final usage in `done`

### Gemini

- Instantiate `LLMClient` with `GEMINI_API_KEY`
- Send a simple text completion against `gemini-2.5-flash`
- Send a tool-calling request and verify `functionCall.args` stays object-shaped
- Send a streaming request and verify:
  - text streaming from `streamGenerateContent`
  - complete tool-call event emission
  - final usage in `done`
- Confirm typed failures on bad key / deliberate invalid payload

### Conversation / Session

- Create a conversation through `await client.conversation({ ... })`
- Verify `send()` updates totals and persists into `InMemorySessionStore`
- Verify `send()` auto-executes tools, accumulates per-send usage across model/tool rounds, and enforces `MaxToolRoundsError`
- Verify `sendStream()` commits history only on `done`
- Verify `sendStream()` pauses on tool calls, executes tools, resumes streaming, and emits a single final aggregated `done` chunk
- Verify conversation budgets are forwarded as remaining per-round `budgetUsd` values
- Verify `toMarkdown()` exports a readable transcript with metadata
- Verify `SummarisationStrategy` waits for async summarizers and preserves the latest user turn
- Restore the same session id and confirm history/system prompt survive round-trips

### Postgres / Neon Session Store

- Instantiate `PostgresSessionStore.fromEnv()` with the local `DATABASE_URL`
- Run `ensureSchema()` and confirm the table plus indexes exist or are reused
- Persist one snapshot with `set()`
- Confirm `get()` and `list()` return the saved row
- Confirm `delete()` removes it cleanly
- Confirm `LLMClient.fromEnv()` restores an existing conversation without manually passing `sessionStore`
- Do not print the connection string or credentials in logs

### Usage Logging / Cost Tracking

- Instantiate `PostgresUsageLogger.fromEnv()` with the local `DATABASE_URL`
- Attach it to `LLMClient.fromEnv({ usageLogger })`
- Send one completion and confirm a usage row is inserted
- Run `client.getUsage({ sessionId, tenantId })` and confirm the aggregate matches the live request
- Confirm `ConsoleLogger` is development-only and that logger failures do not break successful completions
- Confirm per-call budget guards support `throw`, `warn`, and `skip` before provider dispatch
- Confirm `client.exportUsage('json' | 'csv')` serializes the aggregate shape correctly
- Confirm streaming fallback happens only before the first user-visible chunk is emitted
- Confirm `stream.cancel()` and `conversation.sendStream().cancel()` abort cleanly

### Session API

- Instantiate `createSessionApi({ client, sessionStore })`
- Verify lifecycle: create -> message -> get -> paginated messages -> compact -> fork -> list -> delete
- Verify `POST /sessions/{id}/message?stream=true` emits canonical SSE events
- Verify tenant middleware overrides caller-supplied tenant ids
- Verify cross-tenant access returns isolated records and that a second tenant can create/delete its own session with the same `sessionId` without affecting the first tenant
- Verify `withRequestContext(context, execute)` is invoked around request handling
- Verify [SESSION_API.md](/Users/rishabh/Desktop/tryandtested/chatbot101/SESSION_API.md) still matches the endpoint surface and Responses-style mapping

### Redis Session Store

- Use the unit suite in [test/redis-session-store.test.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/test/redis-session-store.test.ts) as the baseline contract
- Verify JSON storage, tenant filtering, TTL option wiring, and `scanIterator()` / `keys()` list behavior

### Price Override Path

- Instantiate `LLMClient`
- Call `client.updatePrices({ 'gpt-4o': { inputPrice: 999 } })`
- Confirm `client.models.get('gpt-4o').inputPrice === 999`

## Remaining Task Areas

No implementation tasks remain open in `todo.md`; the only remaining items are documented roadmap/deferred-scope notes.

## What To Report Back

The testing agent should report:

1. Whether `typecheck`, `lint`, `test`, `build`, `sizecheck`, `depcheck`, `edgecheck`, `bench:complete`, `bench:first-token`, `bench:memory`, `bench:concurrency`, `pricecheck`, and `docs:api` pass unchanged.
2. Whether Anthropic, OpenAI, Gemini, Postgres/Neon session persistence, and Postgres/Neon usage logging live smoke tests pass with the locally populated `.env`.
3. Any mismatches between `todo.md` status and actual code behavior.
4. Any missing environment variables, flaky tests, adapter regressions, or session restore issues.
5. Whether `T-10`, `T-11`, `T-12.1` to `T-12.6`, `T-13.1` to `T-13.6`, `T-14.1` to `T-14.9`, `T-15.1` to `T-15.6`, `T-16.1` to `T-16.5`, `T-17.1` to `T-17.6`, `T-18.1` to `T-18.6`, `T-19.1` to `T-19.10`, `T-20.1` to `T-20.5`, `T-21.1` to `T-21.7`, `T-22.1` to `T-22.6`, and `T-23.1` to `T-23.4` behave as marked.
