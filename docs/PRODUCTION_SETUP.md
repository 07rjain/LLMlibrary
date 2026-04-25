# Production Setup

This page is the practical production companion to the general [Production Guide](./PRODUCTION_GUIDE.md).

Use it when you want a concrete answer to:

- which env vars do I need
- which ones are optional
- how should I wire the client in production
- where conversation history is saved
- where embedding vectors are saved
- what the library does not persist automatically

## 1. Environment Variables

The library reads credentials and database configuration from your application environment.

Recommended production `.env` shape:

```env
# Provider credentials: set only the ones you actually use.
OPENAI_API_KEY=
OPENAI_ORG_ID=
OPENAI_PROJECT_ID=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# Shared Postgres database for sessions, usage logs, and optional retrieval storage.
# Prefer an explicit SSL mode in production.
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DB_NAME?sslmode=verify-full
```

Important rules:

- Do not commit `.env` files.
- Set models in code, not in `.env`.
- `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are optional.
- `DATABASE_URL` is optional for simple stateless usage, but it is required for:
  - `PostgresSessionStore`
  - `PostgresUsageLogger`
  - `PostgresKnowledgeStore`

Minimal env combinations:

- OpenAI generation only:
  - `OPENAI_API_KEY`
- Anthropic generation only:
  - `ANTHROPIC_API_KEY`
- Gemini generation only:
  - `GEMINI_API_KEY`
- Durable conversations and usage logging:
  - provider key(s)
  - `DATABASE_URL`
- Embeddings plus retrieval:
  - `GEMINI_API_KEY`
  - `DATABASE_URL`
  - plus any additional provider key if you want a different model for final answer generation

## 2. Recommended Production Wiring

The library can auto-wire Postgres persistence when `DATABASE_URL` is present, but production applications should usually be explicit.

Recommended pattern:

```ts
import {
  LLMClient,
  PostgresSessionStore,
  PostgresUsageLogger,
} from 'unified-llm-client';

const sessionStore = PostgresSessionStore.fromEnv();
const usageLogger = PostgresUsageLogger.fromEnv();

export const client = LLMClient.fromEnv({
  defaultEmbeddingModel: 'gemini-embedding-2',
  defaultModel: 'claude-sonnet-4-6',
  sessionStore,
  usageLogger,
});
```

Why this is better than implicit wiring:

- startup configuration is obvious in code
- tests can swap stores more easily
- you decide whether persistence and analytics are enabled
- it avoids surprising behavior when `DATABASE_URL` is present in one environment but not another

## 3. What Gets Stored Where

There are three separate persistence concerns in production:

### Conversation history

If you use `PostgresSessionStore`, conversation snapshots are stored in:

- table: `public.llm_sessions` by default

This table stores:

- `tenant_id`
- `session_id`
- `snapshot`
- `message_count`
- `model`
- `provider`
- `total_cost_usd`
- timestamps

This is conversation state, not retrieval state.

### Usage analytics

If you use `PostgresUsageLogger`, usage events are stored in:

- table: `public.llm_usage_events` by default

This table stores:

- provider
- model
- token counts
- cached token counts
- estimated cost
- finish reason
- duration
- tenant and session metadata

This is analytics data, not conversation state and not retrieval vectors.

### Embeddings and retrieval data

If you use `PostgresKnowledgeStore`, retrieval data is stored in four tables by default:

- `public.knowledge_spaces`
- `public.embedding_profiles`
- `public.knowledge_sources`
- `public.knowledge_chunks`

The actual embedding vector is stored in:

- table: `public.knowledge_chunks`
- column: `embedding VECTOR NOT NULL`

The chunk row also stores:

- `tenant_id`
- `bot_id`
- `knowledge_space_id`
- `source_id`
- `embedding_profile_id`
- `chunk_text`
- `citation`
- `metadata`
- `search_document` for lexical search
- `source_type`
- `source_name`
- `title`
- `url`
- `scope_type`
- `scope_user_id`
- `start_offset`
- `end_offset`

Practical meaning:

- the vector is saved in your Postgres database
- the library does not save vectors inside the provider
- the library does not save vectors inside conversation/session rows
- the library does not automatically persist vectors just because `client.embed()` was called

## 4. What `client.embed()` Does And Does Not Do

`client.embed()` only generates embeddings.

It does:

- call the configured embedding transport
- return one or more vectors
- return provider usage metadata when available

It does not:

- create knowledge spaces
- create embedding profiles
- create sources
- write chunk rows
- choose your retrieval policy
- decide how to split documents

That means this code:

```ts
const result = await client.embed({
  model: 'gemini-embedding-2',
  input: 'Refunds are available for 30 days after purchase.',
});
```

returns vectors in memory only.

Nothing is persisted until your app writes those vectors into a store such as `PostgresKnowledgeStore`.

## 5. Recommended Embeddings Storage Flow

For production retrieval, the intended flow is:

1. Create a `PostgresKnowledgeStore`.
2. Call `ensureSchema()` once during startup or ingestion bootstrap.
3. Create a knowledge space.
4. Create an embedding profile.
5. Create a source record.
6. Chunk your content.
7. Call `client.embed()` for those chunks.
8. Write the vectors with `upsertKnowledgeChunk()`.
9. Mark the source ready and activate the embedding profile.
10. Query through `createDenseRetriever()` or `createHybridRetriever()`.

Example:

```ts
import {
  LLMClient,
  createPostgresKnowledgeStore,
} from 'unified-llm-client';
import { chunkText, cleanText, stripHtml } from 'unified-llm-client/chunking';

const client = LLMClient.fromEnv({
  defaultEmbeddingModel: 'gemini-embedding-2',
  defaultModel: 'claude-sonnet-4-6',
});

const store = createPostgresKnowledgeStore({
  connectionString: process.env.DATABASE_URL,
});

await store.ensureSchema();

await store.upsertKnowledgeSpace({
  id: 'kb-support',
  tenantId: 'tenant-1',
  botId: 'bot-1',
  name: 'Support Knowledge Base',
});

await store.upsertEmbeddingProfile({
  id: 'profile-2026-04-25',
  tenantId: 'tenant-1',
  botId: 'bot-1',
  knowledgeSpaceId: 'kb-support',
  provider: 'google',
  model: 'gemini-embedding-2',
  dimensions: 3072,
});

await store.upsertKnowledgeSource({
  id: 'refund-policy',
  tenantId: 'tenant-1',
  botId: 'bot-1',
  knowledgeSpaceId: 'kb-support',
  embeddingProfileId: 'profile-2026-04-25',
  sourceType: 'pdf',
  name: 'refund-policy.pdf',
  status: 'processing',
});

const text = cleanText(stripHtml('<h1>Refund Policy</h1><p>Refunds last 30 days.</p>'));
const chunks = chunkText(text, { chunkSize: 900, overlap: 120 });
const embeddings = await client.embed({
  model: 'gemini-embedding-2',
  input: chunks.map((chunk) => chunk.text),
  purpose: 'retrieval_document',
});

for (const [index, chunk] of chunks.entries()) {
  await store.upsertKnowledgeChunk({
    id: `refund-policy:${index}`,
    tenantId: 'tenant-1',
    botId: 'bot-1',
    knowledgeSpaceId: 'kb-support',
    sourceId: 'refund-policy',
    embeddingProfileId: 'profile-2026-04-25',
    chunkIndex: index,
    text: chunk.text,
    embedding: embeddings.embeddings[index]!.values,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    sourceType: 'pdf',
    sourceName: 'refund-policy.pdf',
    title: 'Refund Policy',
  });
}

await store.upsertKnowledgeSource({
  id: 'refund-policy',
  tenantId: 'tenant-1',
  botId: 'bot-1',
  knowledgeSpaceId: 'kb-support',
  embeddingProfileId: 'profile-2026-04-25',
  sourceType: 'pdf',
  name: 'refund-policy.pdf',
  status: 'ready',
});

await store.activateEmbeddingProfile({
  tenantId: 'tenant-1',
  botId: 'bot-1',
  knowledgeSpaceId: 'kb-support',
  embeddingProfileId: 'profile-2026-04-25',
});
```

`activateEmbeddingProfile()` is fail-closed. If the knowledge space does not exist, or if the embedding profile belongs to a different tenant, bot, or knowledge space, it throws instead of silently doing nothing.

## 6. Retrieval Safety Rules

Production retrieval should always stay fully scoped.

For `PostgresKnowledgeStore`, dense and lexical search require:

- `tenantId`
- `botId`
- `knowledgeSpaceId`
- `embeddingProfileId`

This is a deliberate fail-closed design.

Do not:

- trust tenant ids from the client
- search without all filters
- mix vectors from different embedding profiles
- reuse one profile id across different dimensions or models

Recommended rule:

- derive `tenantId` from auth middleware on the server
- keep one active embedding profile per knowledge space
- reindex into a new profile when model or dimensions change

## 7. In-Memory Versus Postgres For Embeddings

`createInMemoryKnowledgeStore()` is useful for:

- local demos
- tests
- single-process development

But production retrieval should use `PostgresKnowledgeStore` because:

- vectors survive process restarts
- metadata and vectors stay queryable together
- you can index the `embedding` column with `pgvector`
- you can store retrieval metadata and source state in one database

If you use the in-memory store, vectors are saved only in process memory and disappear on restart.

## 8. Database Notes For Production

`PostgresKnowledgeStore.ensureSchema()` creates:

- schema if missing
- `vector` extension when enabled
- retrieval tables
- standard lookup indexes

You should still make deliberate production decisions about:

- backups
- connection pooling
- RLS or app-enforced tenant isolation
- HNSW indexes per active embedding profile where needed
- schema migration ownership

If you want explicit HNSW index SQL, the library also exposes:

- `createPgvectorHnswIndexSql()`

## 9. Recommended Production Checklist

- Keep provider credentials in your app environment, not in source control.
- Prefer explicit production wiring for session store and usage logger.
- Use `DATABASE_URL` with explicit SSL settings.
- Treat `client.embed()` as a vector generation step, not persistence.
- Save vectors in `PostgresKnowledgeStore` if you need durable retrieval.
- Keep retrieval fully scoped by tenant, bot, knowledge space, and embedding profile.
- Reindex into a new profile when the embedding model or dimensions change.
- Keep live-provider tests opt-in.
- Use the mock client for CI that must not hit external APIs.

## Related Pages

- [Getting Started](./GETTING_STARTED.md)
- [Persistence And Session API](./PERSISTENCE_AND_SESSION_API.md)
- [Production Guide](./PRODUCTION_GUIDE.md)
- [Embeddings Integration Report](./EMBEDDINGS_REPORT.md)
- [Retrieval API Integration Report](./RETRIEVAL_API_INTEGRATION_REPORT.md)
