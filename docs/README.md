# User Guide

This guide is for developers who want to use `unified-llm-client` as an application dependency, not contributors working on the library internals.

If you are opening the repository for the first time, read the pages below in order:

1. [Getting Started](./GETTING_STARTED.md)
2. [Completions And Streaming](./COMPLETIONS_AND_STREAMING.md)
3. [Conversations And Tools](./CONVERSATIONS_AND_TOOLS.md)
4. [Persistence And Session API](./PERSISTENCE_AND_SESSION_API.md)
5. [Session API Reference](./SESSION_API_REFERENCE.md)
6. [Production Guide](./PRODUCTION_GUIDE.md)

## What This Library Gives You

- One `LLMClient` surface for OpenAI, Anthropic, and Gemini
- Shared request and response types across providers
- One-off completions and streaming
- Stateful conversations with optional tool execution
- Session persistence in memory, Postgres, or Redis
- Usage and cost tracking
- A framework-agnostic Session API built on `Request` and `Response`
- Routing and fallback rules for production traffic

## Which Page To Read For Which Task

- "I just want one model call to work"
  Read [Getting Started](./GETTING_STARTED.md)
- "I need streaming output"
  Read [Completions And Streaming](./COMPLETIONS_AND_STREAMING.md)
- "I need tool calls or persistent conversation state"
  Read [Conversations And Tools](./CONVERSATIONS_AND_TOOLS.md)
- "I need saved history or HTTP endpoints"
  Read [Persistence And Session API](./PERSISTENCE_AND_SESSION_API.md)
- "I need routing, budgets, testing, or rollout guidance"
  Read [Production Guide](./PRODUCTION_GUIDE.md)

## Reference Docs

- API reference: [docs/api/index.html](./api/index.html)
- Session API contract: [SESSION_API_REFERENCE.md](./SESSION_API_REFERENCE.md)
- Provider comparison: [PROVIDER_COMPARISON.md](./PROVIDER_COMPARISON.md)
- Migration notes: [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- Cost policy and pricing notes: [COST_AND_PRICING.md](./COST_AND_PRICING.md)

## Typical Adoption Path

1. Install the package from GitHub or a local path.
2. Add provider keys to the consuming application's `.env`.
3. Create `LLMClient.fromEnv({ defaultModel })`.
4. Ship one `complete()` call.
5. Add `stream()` or `conversation()` once the first path works.
6. Add a durable `sessionStore` and `usageLogger` when you need persistence or analytics.
7. Add `ModelRouter` and budget policies after you understand real production traffic.

## Before You Start

- Node `>=18` is required.
- The consumer project owns the environment variables. The library does not read the `.env` in this repository unless you run examples from this repository.
- If you want durable conversations, add `DATABASE_URL` or wire your own `RedisSessionStore`.
- If you want aggregated usage exports, use `PostgresUsageLogger`.
