# Project Status

Prepared: 2026-04-15

## What Is Done

- Phase 1 foundation is complete: package setup, TypeScript, build, lint, test, CI, pricing, retries, SSE parsing, cost calculation, and token estimation.
- Phase 2 provider adapters are complete for Anthropic, OpenAI, and Gemini, including streaming, tool translation, typed errors, and usage normalization.
- Phase 3 conversation/session work is complete:
  - `Conversation` supports `send()`, `sendStream()`, restore, serialize, clear, totals, and `toMarkdown()`.
  - Context management includes `SlidingWindowStrategy` and `SummarisationStrategy`.
  - Session storage includes `InMemorySessionStore`, `PostgresSessionStore`, and `RedisSessionStore`.
  - `LLMClient` auto-uses `PostgresSessionStore.fromEnv()` when `DATABASE_URL` is set and no explicit `sessionStore` is provided.
- Phase 4 tool/stream/router work is complete:
  - `defineTool()` is exported for typed tool definitions.
  - `Conversation.send()` auto-executes tool calls with timeout handling, structured tool errors, parallel execution, and `MaxToolRoundsError` enforcement.
  - `Conversation.sendStream()` now pauses on tool calls, executes tools, resumes model streaming, and emits one final aggregated `done` chunk.
  - `ModelRouter` now supports ordered rules, fallback chains, deterministic weighted A/B routing, and `UsageEvent.routingDecision` logging.
- Phase 5 usage/cost tracking is complete:
  - `UsageLogger`, `ConsoleLogger`, and batched `PostgresUsageLogger` are implemented.
  - `LLMClient.complete()` / `stream()` enforce per-call estimated budget guards.
  - `Conversation` enforces per-session budget guards by forwarding remaining budget across tool/model rounds.
  - `LLMClient.getUsage()` aggregates persisted usage when backed by `PostgresUsageLogger`.
- Phase 6 session API work is complete:
  - `createSessionApi()` / `SessionApi` provide framework-agnostic `Request` / `Response` endpoints for session lifecycle operations.
  - Endpoints cover create, message, session get, paginated messages, delete, compact, fork, and session list.
  - Streaming message delivery is exposed as canonical SSE events.
  - Tenant middleware and a request-context hook are available for auth and RLS-style DB scoping.
  - `SESSION_API.md` documents the OpenAI Responses-style mapping and future async/background design.
- Phase 7 testing, documentation, and performance work is complete:
  - Provider mock-server coverage now exercises realistic text, tool, stream, and rate-limit flows for Anthropic, OpenAI, and Gemini.
  - Cross-tenant Session API isolation, lifecycle inspection, live-smoke gating, and launch-model cost-accuracy coverage are in place.
  - Public APIs now carry JSDoc, `typedoc.json` generates API docs into `docs/api`, and GitHub Pages publishing is wired for releases.
  - Provider comparison, migration, and changelog docs are in the repo.
  - Bundle-size, request-overhead, 10,000-turn memory, and 100-session concurrency checks are implemented as scripts and validated locally.
- The public client surface supports `complete()`, `stream()`, `conversation()`, `getUsage()`, session API creation, model registry access, price overrides, and `LLMClient.mock()`.

## Verified State

- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test` passes
- `pnpm build` passes
- `pnpm sizecheck` passes
- `pnpm bench:complete` passes
- `pnpm bench:memory` passes
- `pnpm bench:concurrency` passes
- `pnpm docs:api` passes
- Current automated test count: `170` passing tests, with `4` opt-in live tests skipped unless `LIVE_TESTS=1`
- Current coverage from `pnpm test`:
  - `92.40%` statements / lines
  - `86.26%` branches
  - `96.80%` functions
- Previously verified live smoke with the local `.env`:
  - Anthropic text completion
  - OpenAI text completion
  - Gemini text completion
  - Postgres session-store schema/create/read/list/delete against `DATABASE_URL`
  - End-to-end `LLMClient.fromEnv()` auto-persistence and restore against OpenAI plus `DATABASE_URL`
  - End-to-end `PostgresUsageLogger` usage insert plus `client.getUsage()` aggregation against OpenAI plus `DATABASE_URL`

## Remaining Work

- Remaining PRD backlog items such as OpenAI exact token counting, stream cancellation contract, usage export, CI drift checks, and edge-runtime verification
- Open scope decisions in [todo.md](/Users/rishabh/Desktop/tryandtested/chatbot101/todo.md) around launch-provider breadth and Phase 2 roadmap items

## Suggested Validation For Another Agent

1. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm sizecheck`, `pnpm bench:complete`, `pnpm bench:memory`, `pnpm bench:concurrency`, and `pnpm docs:api`.
2. Re-run live smoke tests with the local `.env`, without printing secrets.
3. Verify default conversation persistence by creating a `LLMClient.fromEnv()` instance and restoring a session via `conversation({ sessionId })`.
4. Verify `PostgresUsageLogger.fromEnv()` persists a usage row and that `client.getUsage({ sessionId })` returns it.
5. Exercise the in-process Session API lifecycle in [src/session-api.ts](/Users/rishabh/Desktop/tryandtested/chatbot101/src/session-api.ts) and confirm [SESSION_API.md](/Users/rishabh/Desktop/tryandtested/chatbot101/SESSION_API.md) matches the code.
6. Run `LIVE_TESTS=1 pnpm test:live` after exporting the populated `.env`.
7. Check that `todo.md` matches the actual code state before starting any new implementation work.
