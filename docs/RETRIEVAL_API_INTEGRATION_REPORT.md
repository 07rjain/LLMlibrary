# Retrieval API Integration Report

Prepared: `2026-04-24`

This report reviews [another_report_on_embeddings.md](./another_report_on_embeddings.md) and turns it into a concrete integration plan for retrieval in `unified-llm-client`, with specific guidance for tenant isolation, shared-vs-private knowledge, safety, and scaling.

## Executive Summary

- Your report is directionally correct on the most important architectural point:
  - add `client.embed()` to the core library
  - keep chunking, vector storage, retrieval policy, citations, and ingestion jobs outside the core generation path
- The current project decision is narrower than the earlier cross-provider plan:
  1. support the Google Embedding 2 path only in v1
  2. defer OpenAI embeddings
  3. reject Anthropic embeddings
  4. keep retrieval modular and separate from `complete()` / `conversation()`

## What In Your Report Is Right

- `client.embed()` should be first-class.
- Retrieval should not be hidden inside the completion transport.
- `anthropic` should not be exposed as a first-party embeddings provider.
- The widget app should own:
  - source ingest
  - chunking
  - vector storage
  - retrieval policy
  - citations
  - ingestion status and retries
- Retrieval queries must be scoped. Searching across tenants, bots, or embedding profiles is a hard no.
- Reindexing should happen through embedding profiles, not by mixing vectors from different models or dimensions.

## What Needs Adjustment

### 1. The public API should reflect the v1 Google-only product decision

The product scope has now changed from “possible multi-provider embeddings” to:

- Google Embedding 2 only in v1
- file/PDF-capable embedding use cases are the driver
- OpenAI embeddings are deferred
- Anthropic embeddings remain unsupported

That means the library API should be shaped so that:

- Google is the only accepted embedding provider in the first slice
- the request surface can support the widget’s file/PDF-oriented use case
- retrieval remains modular even though provider scope is narrow

### 2. `tenantId` and `botId` should not mean retrieval routing inside `client.embed()`

It is fine for `EmbeddingRequestOptions` to carry `tenantId` and `botId` for:

- usage logging
- observability
- tracing

But those fields should not change embedding semantics. The embedding request should stay stateless. Actual retrieval routing and isolation should happen in the app-owned retrieval layer and database filters.

### 3. Retrieval should not become a hidden side effect of `complete()`

Do not add a design where `complete()` silently reaches into a vector store. That would make:

- tests less deterministic
- provider behavior less transparent
- tenancy mistakes more dangerous

Keep retrieval explicit.

## Recommended Way To Add Retrieval To The Existing API

The cleanest design is a two-layer approach.

### Layer 1: core library

Add only these embeddings capabilities to `LLMClient`:

- `client.embed(options)`
- embedding-capable model metadata in the registry
- model-kind validation
- embedding usage reporting

Do not add:

- knowledge-base tables
- chunking
- ingestion queues
- hidden retrieval during `complete()`

### Layer 2: optional retrieval module or app layer

Add retrieval as a separate exported surface, not as a side effect of generation.

Recommended shape:

```ts
const store = createPostgresKnowledgeStore({ pool });
const retriever = createHybridRetriever({
  client,
  store,
});

const results = await retriever.search({
  tenantId,
  botId,
  embeddingProfileId,
  query: userMessage,
  topK: 8,
});
```

Recommended optional exports:

- `createPostgresKnowledgeStore()`
- `createDenseRetriever()`
- `createHybridRetriever()`
- `mergeRetrievalCandidates()`
- `formatRetrievedContext()`

This keeps `LLMClient` small while still giving the widget product a first-party retrieval path.

## How Retrieval Should Work In Practice

### Ingestion flow

1. Create or resolve the active `embedding_profile`.
2. Create a `knowledge_source` row in `queued` state.
3. Parse the source in the app:
   - PDF
   - URL
   - FAQ
   - plain text
4. Chunk content.
5. Call `client.embed()` on each chunk or batch.
6. Store vectors plus metadata in `knowledge_chunks`.
7. Mark the source `ready` only after all vectors are committed.

### Query-time flow

1. Resolve the authenticated tenant and target bot.
2. Resolve the bot's active embedding profile.
3. Embed the user query with that exact profile.
4. Run dense vector search with strict filters.
5. Optionally run lexical search in parallel.
6. Merge and rerank candidates.
7. Build the final retrieval context and citations.
8. Pass that context into `complete()` or `conversation.send()`.

That means retrieval is explicit orchestration around generation, not part of the transport itself.

## How Data Segregation Should Work

This is the most important part for correctness.

### Separate the axes of isolation

Use four distinct scopes:

1. `tenant_id`
2. `bot_id`
3. `embedding_profile_id`
4. `visibility_scope`

`visibility_scope` should distinguish:

- shared bot knowledge
- tenant-wide knowledge
- optional user-private knowledge

If the widget only uses shared bot knowledge right now, keep `visibility_scope = 'bot'` and do not add user-level retrieval yet.

### Recommended hierarchy

```txt
tenant
  -> bot
    -> knowledge_space
      -> embedding_profile
        -> source
          -> chunk
```

This gives you clean control over:

- which bot sees which knowledge
- when a bot switches to a new embedding model
- how reindexing happens without corrupting live retrieval

### Shared vs private data

Most chatbot traffic does not require one vector index per end user.

Recommended default:

- knowledge is shared at the `tenant + bot` level
- conversation state is separate and scoped by `tenant + session`
- end-user count should increase chat sessions, not duplicate the bot's knowledge vectors

Only add user-private retrieval when the product truly needs it. If you do, add:

- `scope_type = 'bot' | 'user'`
- `scope_user_id`

and require both in the retrieval filter for private searches.

## Recommended Schema

Recommended tables:

1. `knowledge_spaces`
2. `embedding_profiles`
3. `knowledge_sources`
4. `knowledge_chunks`

Recommended `knowledge_spaces` fields:

- `id`
- `tenant_id`
- `bot_id`
- `name`
- `visibility_scope`
- `created_at`

Recommended `embedding_profiles` fields:

- `id`
- `knowledge_space_id`
- `tenant_id`
- `bot_id`
- `provider`
- `model`
- `dimensions`
- `distance_metric`
- `task_instruction`
- `status`
- `created_at`

Recommended `knowledge_sources` fields:

- `id`
- `knowledge_space_id`
- `tenant_id`
- `bot_id`
- `source_type`
- `external_id`
- `name`
- `checksum`
- `status`
- `progress_percent`
- `error_message`
- `created_at`
- `updated_at`

Recommended `knowledge_chunks` fields:

- `id`
- `knowledge_space_id`
- `tenant_id`
- `bot_id`
- `source_id`
- `embedding_profile_id`
- `chunk_index`
- `content`
- `citation jsonb`
- `metadata jsonb`
- `fts tsvector`
- `embedding`
- `created_at`

## The Retrieval Filter Must Be Non-Negotiable

Every retrieval query should filter by:

- `tenant_id`
- `bot_id`
- `knowledge_space_id`
- `embedding_profile_id`
- `source.status = 'ready'`

Optional filters:

- `scope_type`
- `scope_user_id`
- `locale`
- `content_type`

That is stricter than only `tenant_id + bot_id`, and it should be.

## How To Keep It Safe

### 1. Derive scope server-side

Never trust `tenantId` from the browser request body for retrieval filters.

Use:

- auth token
- signed session
- API gateway context
- server-side bot ownership lookup

The browser can send `botId`, but the server must still verify that:

- the caller belongs to that tenant
- that bot belongs to that tenant

### 2. Use Row-Level Security in Postgres

Application filters are necessary, but not sufficient at scale.

Recommended:

- enable RLS on `knowledge_spaces`, `knowledge_sources`, and `knowledge_chunks`
- set tenant context per request using a trusted server-side mechanism
- apply policies that block reads outside the active tenant

Application code should still filter by `bot_id` and `embedding_profile_id`. RLS is the last line of defense, not the only one.

### 3. Treat embedding profiles as immutable

Do not update a live profile in place.

Instead:

1. create a new `embedding_profile`
2. reindex into that profile
3. validate retrieval quality
4. switch the bot's active profile pointer

That avoids mixing vectors with different:

- models
- dimensions
- task instructions
- normalization behavior

### 4. Make retrieval fail closed

If retrieval fails, the chatbot should not search broader by relaxing tenant or bot filters.

Fallback order should be:

1. retry local query
2. degrade to lexical-only inside the same scope
3. answer without KB context
4. clearly say no reliable source was found

Never broaden scope as a fallback.

## How To Keep It Reliable At Scale

### 1. Separate online retrieval from offline indexing

Do not embed uploaded documents in the chat request path.

Use:

- ingestion workers
- job queue
- source statuses
- idempotent chunk upserts

Chat traffic should only do:

- query embedding
- retrieval
- reranking
- generation

### 2. Add idempotency and checksums

Every source should carry a checksum so the system can detect:

- duplicate uploads
- unchanged URLs
- unnecessary reindex requests

Every ingest job should be safe to retry without duplicating chunks.

### 3. Use blue/green profile rollouts

For reindexing:

- keep the active profile serving traffic
- build the new profile in parallel
- switch over only when the new profile is complete

This is the safest way to handle many bots and many tenants without downtime.

### 4. Start with one Postgres table, partition later

Recommended starting point:

- one `knowledge_chunks` table
- vector index per active profile or dimension family
- B-tree indexes for tenant and bot scoping
- GIN for lexical search

Recommended scale trigger:

- when chunk counts and index sizes become operationally painful, partition by hashed `tenant_id`
- if a few tenants dominate traffic, consider isolating those tenants or using dedicated partitions

Do not over-partition on day one.

### 5. Keep hot-path limits explicit

Set hard limits on:

- `topK`
- maximum rerank candidate set
- maximum retrieval context tokens
- maximum ingest chunk size
- maximum concurrent embed jobs per tenant

This prevents one tenant or one bad source from overwhelming the system.

### 6. Observe retrieval as its own system

Track:

- embed latency
- vector search latency
- lexical search latency
- rerank latency
- retrieval hit count
- no-hit rate
- retrieval source mix
- answer-with-citation rate
- per-tenant and per-bot error rates

Do not hide retrieval metrics inside generic completion metrics.

## Recommended Public Surface

Recommended core surface in `unified-llm-client`:

- `client.embed()`

Recommended optional surface:

- `createPostgresKnowledgeStore()`
- `createDenseRetriever()`
- `createHybridRetriever()`
- `formatRetrievedContext()`

What I would not add to the core surface:

- `client.retrieve()`
- `client.ingestKnowledge()`
- automatic retrieval inside `complete()`

Those features are too product-specific and would make the library harder to keep correct.

## Recommended Rollout

### Phase 1

- add `client.embed()`
- support the selected Google Embedding 2 path
- add model-kind validation

### Phase 2

- add app-owned Postgres `pgvector` storage
- add dense retrieval with strict filters
- add source statuses and background indexing

### Phase 3

- add lexical search
- add hybrid candidate merge
- add citations

### Phase 4

- add reranking
- add retrieval evaluation fixtures
- add blue/green embedding profile rollout

### Phase 5

- add private user-scoped knowledge only if the product truly needs it
- add advanced partitioning or dedicated vector infrastructure only when Postgres stops being sufficient

## Bottom Line

The right way to add retrieval to the existing API is not to make `LLMClient` own RAG end to end.

The safer design is:

- `client.embed()` in the core client
- app-owned or optional-module retrieval around it
- strict server-side scope derivation
- immutable embedding profiles
- Postgres + `pgvector` with strong filters and RLS
- shared bot-level knowledge by default, not one vector index per user
- Google-only embeddings support in v1, with other providers deferred or rejected

That keeps the current library clean, prevents tenant leakage, and gives you a path to scale without rewriting the API later.

## Sources

- OpenAI embeddings API reference: https://developers.openai.com/api/reference/resources/embeddings/methods/create
- OpenAI retrieval guide: https://developers.openai.com/api/docs/guides/retrieval
- Gemini API embeddings guide: https://ai.google.dev/gemini-api/docs/embeddings
- Gemini API embeddings reference: https://ai.google.dev/api/embeddings
- Vertex AI multimodal embeddings: https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings
- Anthropic embeddings guide: https://platform.claude.com/docs/en/build-with-claude/embeddings
- pgvector README: https://github.com/pgvector/pgvector
- PostgreSQL full-text search indexes: https://www.postgresql.org/docs/current/textsearch-indexes.html
