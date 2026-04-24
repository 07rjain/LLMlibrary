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
- Stateless OpenAI Responses transport while keeping conversation/session state inside this library
- One-off completions and streaming
- Stateful conversations with optional tool execution
- Session persistence in memory, Postgres, or Redis
- Usage and cost tracking
- Live provider model discovery through `client.models.listRemote({ provider })`
- A framework-agnostic Session API built on `Request` and `Response`
- Routing and fallback rules for production traffic
- Google Embedding 2 support through `client.embed()`
- Optional retrieval helpers through `unified-llm-client/retrieval`

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
- Embeddings integration report: [EMBEDDINGS_REPORT.md](./EMBEDDINGS_REPORT.md)
- Prompt caching implementation report: [PROMPT_CACHING_REPORT.md](./PROMPT_CACHING_REPORT.md)
- OpenAI Responses migration report: [OPENAI_RESPONSES_MIGRATION_REPORT.md](./OPENAI_RESPONSES_MIGRATION_REPORT.md)
- Migration notes: [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- Cost policy and pricing notes: [COST_AND_PRICING.md](./COST_AND_PRICING.md)

## Current Provider Notes

- OpenAI requests now use the Responses API in stateless mode with library-owned history replay.
- Prompt caching is exposed through provider-specific options rather than one artificial cross-provider abstraction.
- OpenAI uses `providerOptions.openai.promptCaching`.
- Anthropic uses part-level `cacheControl`, tool-level `cacheControl`, and request-level `providerOptions.anthropic.cacheControl`.
- Gemini uses `providerOptions.google.promptCaching.cachedContent`, and explicit cache resources can be managed with `client.googleCaches`.
- `client.models.listRemote({ provider })` fetches the provider's live model list without changing the local routing registry.
- `client.embed()` is now available for Google Embedding 2.
- Retrieval remains explicit app orchestration; the helper module gives you `createDenseRetriever()`, `createHybridRetriever()`, and `formatRetrievedContext()` without changing `complete()` or `conversation()`.
- The active implementation tracker is stored in the repository root as `prompt_caching_todo.md`.
- The embeddings implementation tracker is stored in the repository root as `embeddings_todo.md`.

## Embeddings And Retrieval Quick Start

```ts
import { LLMClient } from 'unified-llm-client';
import {
  createDenseRetriever,
  createPostgresKnowledgeStore,
  formatRetrievedContext,
} from 'unified-llm-client/retrieval';

const client = LLMClient.fromEnv({
  defaultEmbeddingModel: 'gemini-embedding-2',
  defaultModel: 'gpt-4o',
});

const knowledgeStore = createPostgresKnowledgeStore({
  connectionString: process.env.DATABASE_URL,
});

await knowledgeStore.ensureSchema();

const retriever = createDenseRetriever({
  embed: client,
  embedding: { model: 'gemini-embedding-2' },
  store: knowledgeStore,
});

const results = await retriever.search({
  filter: {
    botId: 'bot-1',
    embeddingProfileId: 'profile-2026-04-24',
    knowledgeSpaceId: 'kb-support',
    tenantId: 'tenant-1',
  },
  query: 'What is the refund window?',
  topK: 4,
});

const context = formatRetrievedContext(results, {
  maxResults: 4,
  maxTokens: 900,
});

const answer = await client.complete({
  messages: [
    {
      content: `Question: What is the refund window?\n\n${context.text}`,
      role: 'user',
    },
  ],
});
```

The embedding request itself stays separate:

```ts
const embedding = await client.embed({
  input: 'Refunds are available for 30 days after purchase.',
  purpose: 'retrieval_document',
  providerOptions: {
    google: {
      title: 'Refund Policy',
    },
  },
});
```

`PostgresKnowledgeStore` enforces strict retrieval filters before it will run a dense or lexical search:

- `tenantId`
- `botId`
- `knowledgeSpaceId`
- `embeddingProfileId`

That is intentional. The store fails closed rather than broadening the search scope. Keep stored chunk embeddings and live query embeddings on the same embedding profile. Chunking, ingestion queues, reranking, and automatic retrieval inside `complete()` / `conversation()` remain outside the core library.

## Prompt Caching Quick Start

```ts
const client = LLMClient.fromEnv({ defaultModel: 'gpt-4o' });

await client.complete({
  messages: [{ content: 'Summarize the FAQ.', role: 'user' }],
  providerOptions: {
    openai: {
      promptCaching: {
        key: 'faq-v1',
        retention: '24h',
      },
    },
  },
});

const cache = await client.googleCaches.create({
  model: 'gemini-2.5-flash',
  messages: [{ content: 'Refunds are available for 30 days.', role: 'user' }],
  ttl: '3600s',
});

await client.complete({
  model: 'gemini-2.5-flash',
  messages: [{ content: 'What is the refund window?', role: 'user' }],
  providerOptions: {
    google: {
      promptCaching: {
        cachedContent: cache.name,
      },
    },
  },
});
```

`client.googleCaches.create()` returns cache names in the provider format `cachedContents/{id}`. Pass that name directly into `providerOptions.google.promptCaching.cachedContent` when you want to reuse the cache.

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
