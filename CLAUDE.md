# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Repository: `unified-llm-client`

Package name: `unified-llm-client`
GitHub: https://github.com/07rjain/LLMlibrary
Docs: https://07rjain.github.io/LLMlibrary/
Package manager: **pnpm**

---

## Commands

### Development

```bash
pnpm install                   # Install dependencies
cp .env.example .env           # First-time setup — add API keys
pnpm typecheck                 # tsc -b (strict, no emit)
pnpm lint                      # eslint .
pnpm format                    # prettier --write .
pnpm test                      # vitest run --coverage
pnpm test:watch                # vitest (interactive watch mode)
pnpm build                     # tsup (produces dist/)
pnpm ci                        # typecheck + lint + test + build (full gate)
```

### Running a single test file

```bash
pnpm vitest run test/client.test.ts
pnpm vitest run test/conversation.test.ts
```

### Live provider tests (opt-in, requires real API keys)

```bash
LIVE_TESTS=1 pnpm test:live
```

### Quality checks

```bash
pnpm sizecheck      # Ensure bundle stays within size budget
pnpm depcheck       # Verify no runtime-only deps leak into edge bundle
pnpm edgecheck      # Confirm core surface is edge/browser safe
pnpm pricecheck     # Detect stale model pricing in prices.json
```

### Docs

```bash
pnpm docs:dev       # VitePress local dev server (docs/)
pnpm docs:api       # Regenerate TypeDoc API reference
pnpm docs:build     # Build full docs site for deployment
```

### Benchmarks

```bash
pnpm bench:complete       # Completion round-trip overhead
pnpm bench:first-token    # First-token latency
pnpm bench:memory         # Conversation memory usage
pnpm bench:concurrency    # Concurrent session throughput
```

---

## Architecture

### Canonical type layer (`src/types.ts`)

Everything flows through provider-neutral canonical types. No provider-specific types ever escape the adapter layer. Key types:

- `CanonicalMessage` — `{ role, content: string | CanonicalPart[] }`
- `CanonicalPart` — union of `TextPart | ImageUrlPart | ImageBase64Part | DocumentPart | AudioPart | CanonicalToolCallPart | CanonicalToolResultPart`
- `CanonicalResponse` — `{ text, content, toolCalls, usage, finishReason, model, provider, raw }`
- `StreamChunk` — `text-delta | tool-call-start | tool-call-delta | tool-call-result | done | error`
- `CanonicalTool` — `{ name, description, parameters: CanonicalToolSchema, execute? }`
- `UsageMetrics` — `{ inputTokens, outputTokens, cachedTokens, cost, costUSD }`

### `LLMClient` dispatch flow (`src/client.ts`)

```
client.complete(options)
  └─ resolveRequestPlan()          — run ModelRouter (or direct) to get attempt list
       └─ resolveRequest()         — look up model in ModelRegistry → pin provider
  └─ handleBudgetExceededAction()  — pre-flight cost estimate vs budgetUsd
  └─ dispatchComplete()            — switch on provider → adapter.complete()
  └─ logUsageEvent()               — fire-and-forget to UsageLogger
```

`stream()` follows the same plan but yields `StreamChunk` async-iterables and supports `stream.cancel()` and `AbortSignal`.

### Provider adapters (`src/providers/`)

Three files: `anthropic.ts`, `openai.ts`, `gemini.ts`. Each implements `complete()` and `stream()` using **raw `fetch` with no SDK dependencies**. They translate to/from the canonical types internally. Critical Gemini differences to remember: uses `"model"` role (not `"assistant"`), tool arguments arrive as parsed objects (not JSON strings), and streaming uses a separate endpoint.

### Model registry + pricing (`src/models/`)

`ModelRegistry` maps model ID strings (e.g. `"claude-sonnet-4-6"`) to `ModelInfo` (provider, pricing, context window, capability flags). Pricing lives in `src/models/prices.json`. `pnpm pricecheck` validates freshness. Consumers can call `client.models.register()` to add custom models or `client.updatePrices()` for runtime overrides.

### Conversation (`src/conversation.ts`)

`Conversation` is a stateful multi-turn session. It tracks message history, running token + cost totals, and auto-executes tools (including during streaming with pause/resume). Persisted as `ConversationSnapshot` to a `SessionStore`. `LLMClient.conversation()` creates or restores from the configured store by `sessionId`.

### Context managers (`src/context-manager.ts`)

Two strategies implement the `ContextManager` interface:

- `SlidingWindowStrategy` — drops oldest non-pinned messages when `maxMessages` or `maxTokens` is exceeded
- `SummarisationStrategy` — calls a user-supplied `summarizer()` callback on the dropped window, injecting the summary as a synthetic message. Point `summarizer` at a cheaper model (e.g. `gpt-4o-mini`) in production.

`pinned: true` on a `CanonicalMessage` protects it from both strategies.

### Session stores (`src/session-store.ts`)

All implement `SessionStore<T>`: `get / set / delete / list / clear`.

- `InMemorySessionStore` — default, zero config
- `PostgresSessionStore` — auto-selected when `DATABASE_URL` env var is present; loaded via `node-pg-loader.js` (dynamic import, Node-only)
- `RedisSessionStore` — bring-your-own client (any client with `get/set/del/scanIterator|keys`)

### Session API (`src/session-api.ts`)

`createSessionApi({ client, sessionStore })` returns a framework-agnostic handler accepting standard `Request` / returning standard `Response`. Mount in Express, Fastify, Hono, Next.js, or Cloudflare Workers. Endpoint contract is in `SESSION_API.md`. Mirrors the OpenAI Responses API shape (`previous_response_id` → `sessionId`).

Supported endpoints: `POST /sessions`, `POST /sessions/{id}/message`, `GET /sessions/{id}`, `GET /sessions/{id}/messages`, `DELETE /sessions/{id}`, `POST /sessions/{id}/compact`, `POST /sessions/{id}/fork`, `GET /sessions`.

### Model router (`src/router.ts`)

Optional — attach via `LLMClientOptions.modelRouter`. Supports weighted A/B routing, fallback chains, and usage-based routing. `resolveRoute()` returns an ordered list of attempts; `client.complete()` tries them in sequence, falling back on `AuthenticationError`, `ProviderError`, or `RateLimitError`.

### Edge / Node split

The core surface — `LLMClient`, `Conversation`, routing, in-memory stores, `SessionApi` — is edge-safe (no Node builtins). `PostgresSessionStore` and `PostgresUsageLogger` are loaded only at runtime via `node-pg-loader.js` (dynamic import). Verify with `pnpm edgecheck`.

### Lazy tokenizer loader (`src/openai-tokenizer-loader.js`)

`js-tiktoken` is Node-only and heavy. It is loaded lazily via this loader only when token estimation is actually needed. Do not import it directly.

### Testing patterns

- `LLMClient.mock(options)` creates a `MockLLMClient` with queued `responses[]` and `streams[]` arrays. Each element can be a value or a factory function receiving the resolved request.
- Live e2e tests live in `test/live.e2e.test.ts` and are gated behind `LIVE_TESTS=1`.
- Run `pnpm test` for unit/integration tests only (no live API calls).

---

## Package exports

The package ships multiple named entry points (dual CJS + ESM via tsup):

| Import path | Contents |
|---|---|
| `unified-llm-client` | Full public surface |
| `unified-llm-client/client` | `LLMClient` only |
| `unified-llm-client/errors` | Error classes |
| `unified-llm-client/models` | `ModelRegistry`, `ModelInfo` |
| `unified-llm-client/providers/anthropic` | `AnthropicAdapter` |
| `unified-llm-client/providers/openai` | `OpenAIAdapter` |
| `unified-llm-client/providers/gemini` | `GeminiAdapter` |
| `unified-llm-client/session-api` | `createSessionApi` |
| `unified-llm-client/utils` | Utility helpers |

---

## Environment variables

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENAI_ORG_ID=          # optional
OPENAI_PROJECT_ID=      # optional
GEMINI_API_KEY=
DATABASE_URL=           # auto-enables PostgresSessionStore for conversation()
```

---

## Broader project context: Chatbot Widget SaaS

This library is the LLM engine for a multi-tenant SaaS platform (**[PRODUCT NAME]**) that lets website owners embed an AI chatbot with a single script tag. The chatbot can query the site owner's own live database (Postgres, MySQL, MongoDB, Shopify, etc.) in real-time, plus a RAG knowledge base from uploaded documents.

**Three data layers the chatbot widget uses:**
1. **Internal app DB** (Postgres + pgvector on Neon) — user accounts, widget configs, API keys, chat history, embeddings
2. **User's live operational DB** (the core differentiator) — this library's tool-calling is how the chatbot executes read-only queries against it
3. **Knowledge base / RAG** — Gemini Embedding 2 vectors in pgvector, fallback for unstructured questions

**How this library fits in the widget backend:**
- `LLMClient` with `claude-sonnet-4-6` as default model
- Tool calling (`defineTool`) for `query_user_database`, `search_knowledge_base`, `web_search`
- `conversation()` with `PostgresSessionStore` for per-tenant session persistence (keyed by `tenantId` + `sessionId`)
- `UsageLogger` feeding per-tenant usage accounting for billing
- `SessionApi` as the backend for the widget's REST interface
- Multi-tenancy enforced at the DB level (Postgres RLS) + `tenantId` threaded through every `LLMRequestOptions` call

**API key format:** `cbw_live_<32-char-random>` — stored as SHA-256 hash, shown once at creation.

**Widget delivery:** Shadow DOM script tag (default) or iframe. The public API key in the embed code is scoped to a single `bot_id` + `tenant_id` and can only invoke chat endpoints.

Full PRD: `chatbot_widget_PRD.md` | Research report: `chatbot_widget_report.md` | Session API contract: `SESSION_API.md`
