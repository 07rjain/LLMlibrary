# Unified LLM Client Library TODO

Sources: `LLM_Library_Tasks.docx`, `LLM_Client_Library_PRD.docx`  
Prepared: 2026-04-16

## Overview

- Library: Unified LLM Client Library
- Baseline execution plan: 23 tasks, 120+ subtasks, 7 phases from the implementation task report
- Current implementation scope in task report: Anthropic, OpenAI, Google Gemini
- Expanded launch scope in PRD: Anthropic, OpenAI, Google Gemini, Mistral, Cohere
- Estimated effort in task report: 35-40 engineering days

## Cross-Doc Decisions

- [x] Decide launch provider scope: current release is the documented 3-provider MVP in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)
- [x] Decide adapter strategy: keep raw `fetch` adapters and defer wrapper-layer evaluation in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)
- [x] Finalize authoritative launch model matrix and `prices.json` coverage in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)
- [x] Confirm whether summarisation trimming, A/B routing, Postgres usage logger, and `client.getUsage()` are Phase 1 or Phase 2 in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)
- [x] Confirm package targets: dual `ESM + CJS`, Edge runtime support, and browser support expectations in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)
- [x] Confirm whether the task report supersedes the PRD for implementation details or whether this backlog must absorb both in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)
- [x] Use standard Postgres for durable session storage, with Neon as the current hosted `DATABASE_URL` target

## Current Status

- [x] Phase 1 bootstrap is live with passing `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`
- [x] Phase 7 validation commands also pass: `pnpm sizecheck`, `pnpm depcheck`, `pnpm edgecheck`, `pnpm bench:complete`, `pnpm bench:first-token`, `pnpm bench:memory`, `pnpm bench:concurrency`, `pnpm pricecheck`, and `pnpm docs:api`
- [x] `.env` exists locally and the user has populated API keys for live smoke testing
- [x] `TEST_AGENT_HANDOFF.md` exists for parallel validation/testing work
- [x] `T-01`, `T-02`, `T-04`, `T-05`, `T-06`, and `T-07` are implemented and verified
- [x] `T-03` is implemented and verified
- [x] `T-08` Anthropic adapter is implemented and verified
- [x] `T-09` OpenAI adapter is implemented and verified
- [x] OpenAI transport is now migrated to `POST /v1/responses` in stateless mode with `store: false`, `input`-based history replay, Responses streaming events, and Responses usage normalization
- [x] `T-10` Gemini adapter is implemented and verified
- [x] `T-11` conversation manager core is implemented and verified
- [x] `T-12.1` to `T-12.6` context management, including sliding-window and summarisation strategies, is implemented and verified
- [x] `T-13.1` to `T-13.6` session-store basics are implemented and verified, including Redis and Postgres durable storage
- [x] `T-14.1` to `T-14.9` unified tool definitions plus conversation-level tool execution are implemented and verified
- [x] `T-15.1` to `T-15.6` canonical streaming, abort support, and tool pause/execute/resume behavior are implemented and verified
- [x] `T-16.1` to `T-16.5` model routing, fallback chains, weighted A/B routing, and routing decision logging are implemented and verified
- [x] `T-17.1` to `T-17.6` usage logging, Postgres aggregation, per-call and per-session budget guards, and `client.getUsage()` are implemented and verified
- [x] `T-19.1` to `T-19.10` session API endpoints, SSE streaming, tenant middleware, and request-context hooks are implemented and verified
- [x] `T-20.1` to `T-20.5` Responses-style mapping documentation is implemented and verified
- [x] `T-18.2` to `T-18.6` are implemented in the current `LLMClient` surface
- [x] Live smoke text completions passed against Anthropic, OpenAI, and Gemini using the user-populated local `.env`
- [x] Live smoke session persistence passed against the user-populated `DATABASE_URL` via `PostgresSessionStore`
- [x] Default `LLMClient` conversation persistence now auto-attaches `PostgresSessionStore.fromEnv()` when `DATABASE_URL` is present and no explicit `sessionStore` is provided
- [x] Live smoke usage logging passed against the user-populated `DATABASE_URL` via `PostgresUsageLogger` plus `client.getUsage()`
- [x] Current automated suite passes with `342` tests, `4` opt-in live tests skipped unless `LIVE_TESTS=1`, and coverage at `91.81%` statements / lines, `86.23%` branches, and `96.35%` functions
- [x] Phase 7 integration, documentation, and performance work in `T-21.1` to `T-23.4` is implemented and verified
- [x] Next execution slice: PRD addendum backlog is resolved into shipped code, CI, or documented roadmap items

### Priority Legend

- `P0` MVP blocker
- `P1` Required after MVP / Phase 2
- `P2` Nice to have / future iteration

### Critical Path

1. `T-01` Project Setup
2. `T-02` Core Type Definitions
3. `T-03` Model Registry
4. `T-04` to `T-07` Utilities
5. `T-08` Anthropic Adapter
6. `T-09` OpenAI Adapter and `T-10` Gemini Adapter
7. `T-11` Conversation Manager
8. `T-12` Context Window Management
9. `T-13` Session Store
10. `T-14` Tool System
11. `T-15` Streaming System
12. `T-16` Model Router
13. `T-17` Cost Tracking
14. `T-18` LLMClient Public API
15. `T-19` Session API
16. `T-21` to `T-23` Test, Docs, Perf

### Parallel Work Opportunities

- `T-04`, `T-05`, `T-06`, `T-07`
- `T-08`, `T-09`, `T-10`
- `T-21`, `T-22`, `T-23`

## Phase 1 - Foundation

### T-01 Project Setup
Priority: `P0`  
Effort: `0.5d`  
Dependencies: `None`

- [x] `T-01.1` Init `package.json` with name, version, exports map, and `engines.node >= 18`
- [x] `T-01.2` Add `tsconfig.json` with `strict`, `target: ES2022`, `moduleResolution: bundler`, `declaration`, and project refs
- [x] `T-01.3` Set up `tsup` build pipeline for dual `CJS + ESM`, treeshaking, and source maps
- [x] `T-01.4` Set up Vitest with global mock-fetch test setup, coverage reporting, and E2E tags
- [x] `T-01.5` Add GitHub Actions CI: typecheck -> lint -> test -> build, fail on coverage drop
- [x] `T-01.6` Add ESLint + Prettier with `no-any` in `src/**` and import sorting

### T-02 Core Type Definitions
Priority: `P0`  
Effort: `1d`  
Dependencies: `T-01`

- [x] `T-02.1` Define `CanonicalRole`, `CanonicalMessage`, and `CanonicalPart` (`text | image | tool_call | tool_result`)
- [x] `T-02.2` Define `CanonicalResponse` with text, tool calls, finish reason, model, provider, usage, and raw payload
- [x] `T-02.3` Define streaming discriminated union types: `text-delta | tool-call-start | tool-call-delta | tool-call-result | done | error`
- [x] `T-02.4` Define `CanonicalTool` with name, description, parameters, and optional `execute()`
- [x] `T-02.5` Define `UsageEvent` with provider/model/tokens/cost/tenant/session/bot/duration/finish reason
- [x] `T-02.6` Implement error hierarchy: `LLMError` -> `AuthenticationError`, `RateLimitError`, `ContextLimitError`, `ProviderCapabilityError`, `BudgetExceededError`, `MaxToolRoundsError`, `ProviderError`
- [x] `T-02.7` Define provider capability matrix / `ModelInfo` type

### T-03 Model Registry
Priority: `P0`  
Effort: `0.5d`  
Dependencies: `T-02`

- [x] `T-03.1` Create `prices.json` for launch models with input/output/cache pricing and `lastUpdated`
- [x] `T-03.2` Implement `ModelRegistry` with `list()`, `get()`, `register()`, and `isSupported()`
- [x] `T-03.3` Add capability validation for tool calling, vision, and streaming with clear error messages
- [x] `T-03.4` Add runtime price override API via `LLMClient.updatePrices(overrides)`
- [x] `T-03.5` Add dev-mode staleness warning when pricing data is older than 90 days

### T-04 SSE Parser Utility
Priority: `P0`  
Effort: `0.5d`  
Dependencies: `T-01`

- [x] `T-04.1` Implement `parseSSE()` as an `AsyncGenerator<string>` over native `ReadableStream`
- [x] `T-04.2` Handle multiline `data:` payloads, empty lines, comment lines, and closed streams without sentinel
- [x] `T-04.3` Add unit tests for normal streams, `[DONE]`, mid-stream close, chunked buffers, empty events, and unicode

### T-05 Retry & Backoff Utility
Priority: `P0`  
Effort: `0.5d`  
Dependencies: `T-02`

- [x] `T-05.1` Implement `withRetry()` with exponential backoff and no retries on `400/401/403`
- [x] `T-05.2` Parse `Retry-After` headers from numeric seconds and ISO dates
- [x] `T-05.3` Parse Gemini `retryDelay` from `error.details[]`
- [x] `T-05.4` Add `0-500ms` jitter to every retry backoff
- [x] `T-05.5` Add unit tests for `429`, `500`, non-retryable `400`, and max-attempt behavior

### T-06 Cost Calculator
Priority: `P0`  
Effort: `0.5d`  
Dependencies: `T-03`

- [x] `T-06.1` Implement `calcCostUSD()` using token counts and model pricing
- [x] `T-06.2` Implement `formatCost(usd)` with graceful handling for sub-cent and large values
- [x] `T-06.3` Implement provider usage normalizers for Anthropic, OpenAI, and Gemini
- [x] `T-06.4` Add unit tests for all launch models, cached tokens, zero-cost cases, and unknown model fallback

### T-07 Token Estimator
Priority: `P0`  
Effort: `0.25d`  
Dependencies: `T-01`

- [x] `T-07.1` Implement `estimateTokens(text)` at roughly `3.5 chars/token`
- [x] `T-07.2` Implement `estimateMessageTokens(messages[])` with message overhead
- [x] `T-07.3` Add exact-count wrappers for Anthropic and Gemini token counting endpoints

## Phase 2 - Provider Adapters

### Gemini Gotchas

- Streaming uses `streamGenerateContent`, not `stream: true` on the same URL
- Gemini assistant role is `model`, not `assistant`
- `functionCall.args` is already an object
- `finishReason: STOP` can still mean a tool call, so inspect parts
- Rate-limit retry delay comes from `error.details[].retryDelay`, not `Retry-After`

### T-08 Anthropic Adapter
Priority: `P0`  
Effort: `2d`  
Dependencies: `T-02`, `T-04`, `T-05`, `T-06`

- [x] `T-08.1` Translate canonical messages to Anthropic format with system extraction, role mapping, images, tools, and cache control
- [x] `T-08.2` Translate `CanonicalTool[]` to Anthropic `tools[]` and map tool choice
- [x] `T-08.3` Translate Anthropic response payloads into `CanonicalResponse`
- [x] `T-08.4` Implement authenticated `POST /v1/messages` with `withRetry()`
- [x] `T-08.5` Parse Anthropic SSE events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- [x] `T-08.6` Reassemble streamed tool input JSON and emit canonical tool stream events
- [x] `T-08.7` Map HTTP status and `error.type` to typed `LLMError`s
- [x] `T-08.8` Add integration tests for text, tool calls, streaming, cache hits, `429`, and `529`

### T-09 OpenAI Adapter
Priority: `P0`  
Effort: `2d`  
Dependencies: `T-02`, `T-04`, `T-05`, `T-06`

- [x] `T-09.1` Translate canonical requests to Chat Completions payloads, including developer role, tool messages, null tool-call content, and image parts
- [x] `T-09.2` Translate `CanonicalTool[]` to OpenAI tool definitions and map `tool_choice`
- [x] `T-09.3` Translate Chat Completions responses into `CanonicalResponse`, including cached token usage
- [x] `T-09.4` Implement authenticated `POST /v1/chat/completions` with `stream_options.include_usage = true`
- [x] `T-09.5` Parse streaming `chat.completion.chunk` deltas and accumulate partial tool arguments by index
- [x] `T-09.6` Reassemble streamed tool arguments and emit canonical stream events on `finish_reason: tool_calls`
- [x] `T-09.7` Map HTTP status and OpenAI `error.code` values to typed errors
- [x] `T-09.8` Add integration tests for text, tools, streaming, cached tokens, reasoning model use, `429`, and `500`
- [x] `T-09.9` Replace Chat Completions transport with stateless Responses API transport, including `instructions`, `input`, `parallel_tool_calls`, typed streaming events, and Responses usage fields

### T-10 Gemini Adapter
Priority: `P0`  
Effort: `2.5d`  
Dependencies: `T-02`, `T-04`, `T-05`, `T-06`

- [x] `T-10.1` Translate canonical requests into Gemini `generateContent` format, including `systemInstruction`, role mapping, `functionCall`, and `functionResponse`
- [x] `T-10.2` Translate tools into Gemini `functionDeclarations` with uppercase schema types and tool config mapping
- [x] `T-10.3` Translate Gemini responses into `CanonicalResponse`, including tool-call detection from parts
- [x] `T-10.4` Implement authenticated `generateContent` calls with Gemini-specific retry handling
- [x] `T-10.5` Implement `streamGenerateContent?alt=sse` calls using the separate streaming endpoint
- [x] `T-10.6` Concatenate streamed text and read final usage from the terminating chunk
- [x] `T-10.7` Emit canonical tool-call events from complete streamed `functionCall` objects
- [x] `T-10.8` Map Gemini HTTP status and `error.status` values to typed errors and parse retry delay
- [x] `T-10.9` Add integration tests for text, tools, streaming concat, function calls in streams, safety blocks, and `429`

## Phase 3 - Conversation Manager & Session Store

### T-11 Conversation Manager - Core
Priority: `P0`  
Effort: `2d`  
Dependencies: `T-07`, `T-08`, `T-09`, `T-10`

- [x] `T-11.1` Implement `Conversation` class skeleton with session/model/system/context/budget state
- [x] `T-11.2` Implement `conv.send(text | parts)` to append user input, call provider, append assistant response, and update totals
- [x] `T-11.3` Implement `conv.sendStream(text | parts)` to stream and commit state on `done`
- [x] `T-11.4` Track token counts after every provider call
- [x] `T-11.5` Accumulate total session cost after every call
- [x] `T-11.6` Implement `serialise()` and static `restore()`
- [x] `T-11.7` Implement `toMessages()` for debugging/export
- [x] `T-11.8` Implement `clear()` while preserving the system prompt and total cost

### T-12 Context Window Management
Priority: `P0`  
Effort: `1.5d`  
Dependencies: `T-11`

- [x] `T-12.1` Define `ContextManager` interface with `shouldTrim()` and `trim()`
- [x] `T-12.2` Implement `SlidingWindowStrategy`
- [x] `T-12.3` Support pinned messages, including default-pinned system prompt and latest user message
- [x] `T-12.4` Run pre-call trim checks and log trim events
- [x] `T-12.5` Implement `SummarisationStrategy` using a cheap model to replace older history with a summary snapshot
- [x] `T-12.6` Add unit tests for trimming behavior, pinned-message preservation, and repeated trim cycles

### T-13 Session Store Interface
Priority: `P0`  
Effort: `1d`  
Dependencies: `T-11`

- [x] `T-13.1` Define `SessionStore` interface with `get`, `set`, `delete`, and `list`
- [x] `T-13.2` Implement `InMemorySessionStore`
- [x] `T-13.3` Implement `PostgresSessionStore` with JSONB snapshot storage, tenant scoping, and indexes
- [x] `T-13.4` Implement `RedisSessionStore` with JSON storage and TTL support
- [x] `T-13.5` Define `SessionMeta`
- [x] `T-13.6` Auto-save session snapshots after every `conv.send()` when a store is configured

## Phase 4 - Tools, Streaming & Model Router

### T-14 Unified Tool System
Priority: `P0`  
Effort: `2d`  
Dependencies: `T-08`, `T-09`, `T-10`

- [x] `T-14.1` Implement `defineTool()` with TypeScript inference from JSON-schema-like parameters
- [x] `T-14.2` Translate canonical tools to Anthropic tool format
- [x] `T-14.3` Translate canonical tools to OpenAI tool format
- [x] `T-14.4` Translate canonical tools to Gemini tool format
- [x] `T-14.5` Normalize tool-result messages across Anthropic, OpenAI, and Gemini
- [x] `T-14.6` Implement auto-execute tool loop with timeout and repeated model turns
- [x] `T-14.7` Execute parallel tool calls with `Promise.all()`
- [x] `T-14.8` Add `MaxToolRoundsError` guard with default limit `5`
- [x] `T-14.9` Catch tool execution errors and return structured tool results back to the model

### T-15 Streaming System
Priority: `P0`  
Effort: `1.5d`  
Dependencies: `T-08`, `T-09`, `T-10`

- [x] `T-15.1` Finalize canonical `StreamChunk` union
- [x] `T-15.2` Build Anthropic stream assembler
- [x] `T-15.3` Build OpenAI stream assembler
- [x] `T-15.4` Build Gemini stream assembler
- [x] `T-15.5` Add `AbortController` / `AbortSignal` support to streaming requests
- [x] `T-15.6` Integrate tools into streaming flows, including pause-execute-resume behavior

### T-16 Model Router
Priority: `P0`  
Effort: `1d`  
Dependencies: `T-08`, `T-09`, `T-10`

- [x] `T-16.1` Implement `ModelRouter` with ordered rules and fallback
- [x] `T-16.2` Define `RouterContext`
- [x] `T-16.3` Retry against fallback model after terminal provider errors or exhausted retries
- [x] `T-16.4` Add weighted A/B routing with seeded randomness
- [x] `T-16.5` Log routing decisions into `UsageEvent.routingDecision`

## Phase 5 - LLMClient Public API & Cost Tracking

### T-17 Cost Tracking & Usage Logger
Priority: `P0`  
Effort: `1.5d`  
Dependencies: `T-06`, `T-11`

- [x] `T-17.1` Define `UsageLogger` interface and ensure logger failures never propagate
- [x] `T-17.2` Implement `ConsoleLogger` for development-only output
- [x] `T-17.3` Implement batched `PostgresUsageLogger`
- [x] `T-17.4` Add per-call budget guard using estimated preflight cost
- [x] `T-17.5` Add per-session budget guard using `conv.totalCostUSD`
- [x] `T-17.6` Implement `client.getUsage()` aggregation API when Postgres logging is configured

### T-18 LLMClient - Public API Surface
Priority: `P0`  
Effort: `1d`  
Dependencies: `T-08`, `T-09`, `T-10`, `T-14`, `T-15`, `T-16`, `T-17`

- [x] `T-18.1` Implement `LLMClient` constructor with validation
- [x] `T-18.2` Implement `llm.complete(options)` for non-streaming calls
- [x] `T-18.3` Implement `llm.stream(options)` for streaming calls
- [x] `T-18.4` Implement `llm.conversation(options)` with session-store restore support
- [x] `T-18.5` Expose model registry proxy methods on `llm.models`
- [x] `T-18.6` Implement `LLMClient.mock({ responses })` for tests

## Phase 6 - Session API

### T-19 Session API - Conversation Endpoints
Priority: `P0`  
Effort: `2d`  
Dependencies: `T-13`, `T-18`

- [x] `T-19.1` Add `POST /sessions` to create a new session
- [x] `T-19.2` Add `POST /sessions/{id}/message` to load state, append message, call LLM, save state, and optionally stream
- [x] `T-19.3` Add `GET /sessions/{id}` for metadata and full history
- [x] `T-19.4` Add `GET /sessions/{id}/messages` with pagination
- [x] `T-19.5` Add `DELETE /sessions/{id}` for full session deletion / erasure
- [x] `T-19.6` Add `POST /sessions/{id}/compact` for manual compaction
- [x] `T-19.7` Add `POST /sessions/{id}/fork` to branch from a message index
- [x] `T-19.8` Add `GET /sessions` with tenant-scoped filters and pagination
- [x] `T-19.9` Add session SSE streaming with canonical event mapping
- [x] `T-19.10` Add tenant-auth middleware and DB session context for RLS

### T-20 Session API - OpenAI Responses API Mapping
Priority: `P0`  
Effort: `0.5d`  
Dependencies: `T-19`

- [x] `T-20.1` Document that `POST /sessions/{id}/message` is the `previous_response_id` equivalent
- [x] `T-20.2` Document that `sessionId` maps to OpenAI `conversation`
- [x] `T-20.3` Document that `maxContextTokens + contextStrategy` maps to `context_management / compact_threshold`
- [x] `T-20.4` Design async/background message handling for future enhancement
- [x] `T-20.5` Document `GET ?include=messages,usage,cost` as the `include[]` equivalent

## Phase 7 - Testing, Documentation & Performance

### T-21 Testing - Integration & E2E
Priority: `P0`  
Effort: `2d`  
Dependencies: `T-18`, `T-19`

- [x] `T-21.1` Build provider mock servers with realistic text/tool/stream/error responses
- [x] `T-21.2` Add cross-tenant isolation tests
- [x] `T-21.3` Add provider tool-call round-trip tests for all 3 providers
- [x] `T-21.4` Add context-trimming tests
- [x] `T-21.5` Add cost-accuracy tests for launch models
- [x] `T-21.6` Add Session API lifecycle tests: create -> message -> history -> fork -> compact -> delete
- [x] `T-21.7` Add optional live smoke tests behind `LIVE_TESTS=1`

### T-22 Documentation
Priority: `P1`  
Effort: `2d`  
Dependencies: `T-18`

- [x] `T-22.1` Add JSDoc to all public APIs with examples
- [x] `T-22.2` Write `README.md` quick start, provider setup, feature overview, and docs links
- [x] `T-22.3` Generate Typedoc API reference and publish to GitHub Pages on release
- [x] `T-22.4` Write provider comparison guide
- [x] `T-22.5` Write migration guide from raw provider SDKs
- [x] `T-22.6` Add `CHANGELOG.md` with conventional-commit release entries

### T-23 Performance & Benchmarking
Priority: `P1`  
Effort: `1d`  
Dependencies: `T-18`

- [x] `T-23.1` Benchmark time from `llm.complete()` to provider `fetch()` and keep it under `5ms`
- [x] `T-23.2` Add automated bundle size checks for full bundle and per-provider adapters
- [x] `T-23.3` Run memory leak checks across `10,000` conversation turns
- [x] `T-23.4` Run concurrent-session tests for `100` simultaneous conversations

## Suggested Delivery Order

- [x] Complete Phase 1
- [x] Complete Phase 2
- [x] Complete Phase 3
- [x] Complete Phase 4
- [x] Complete Phase 5
- [x] Complete Phase 6
- [x] Complete Phase 7

## PRD Addendum - Missing or Expanded Scope

### Provider Scope

- [x] `PRD-01` Resolve `Mistral` support by deferring it to the documented roadmap after the 3-provider MVP scope decision
- [x] `PRD-02` Resolve `Cohere` support by deferring it to the documented roadmap after the 3-provider MVP scope decision
- [x] `PRD-03` Add Phase 2 `Groq` adapter planning to [docs/ROADMAP.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/ROADMAP.md)
- [x] `PRD-04` Add Phase 3 `Amazon Bedrock`, `Azure OpenAI`, and `Ollama` adapters to [docs/ROADMAP.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/ROADMAP.md)
- [x] `PRD-05` Finalize current launch model coverage through the authoritative 3-provider matrix in [docs/PRD_DECISIONS.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PRD_DECISIONS.md)

### API and Normalisation Gaps

- [x] `PRD-06` Extend canonical content parts to support `image_url`, `image_base64`, `document`, and `audio`
- [x] `PRD-07` Normalize finish reasons to `stop | length | tool_call | content_filter | error` and preserve raw provider finish reason
- [x] `PRD-08` Ensure provider capability checks reject unsupported modalities with clear `ProviderCapabilityError`s
- [x] `PRD-09` Add OpenAI exact token-count wrapper in addition to Anthropic and Gemini counting support
- [x] `PRD-10` Add `Conversation.toMarkdown()` transcript export
- [x] `PRD-11` Finalize public stream cancellation API (`stream.cancel()` and `conversation.sendStream().cancel()`)
- [x] `PRD-12` Ensure `done` chunks always include full usage and cost metadata
- [x] `PRD-13` Expose raw provider response / finish reason / model metadata so the abstraction does not hide provider specifics

### Cost, Logging, and Error Handling Gaps

- [x] `PRD-14` Add usage export support for `JSON` and `CSV`
- [x] `PRD-15` Support budget breach actions `throw | warn | skip`
- [x] `PRD-16` Include error metadata on all typed errors: provider, model, status code, request ID, retryable
- [x] `PRD-17` Enforce "no credential logging" across logs, errors, and serialised error objects
- [x] `PRD-18` Add weekly `prices.json` drift detection automation in CI
- [x] `PRD-19` Document cost outputs as estimates and define target accuracy / staleness guarantees

### Runtime, Quality, and Phase 2 Backlog

- [x] `PRD-20` Verify no module-level mutable global state across client instances
- [x] `PRD-21` Verify Edge runtime compatibility in addition to Node 18+ via `pnpm edgecheck`
- [x] `PRD-22` Keep production dependencies under the PRD target and track this in CI with `pnpm depcheck`
- [x] `PRD-23` Add first-token latency benchmark for streaming overhead
- [x] `PRD-24` Add nightly live-provider compatibility / API drift checks
- [x] `PRD-25` Add OpenTelemetry spans and trace IDs to [docs/ROADMAP.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/ROADMAP.md)
- [x] `PRD-26` Add Python port planning / parity tracking to [docs/ROADMAP.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/ROADMAP.md)
- [x] `PRD-27` Record the open question on response caching in [docs/ROADMAP.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/ROADMAP.md)
