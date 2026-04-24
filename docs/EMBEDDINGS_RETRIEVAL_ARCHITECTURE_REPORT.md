# Embeddings And Retrieval Architecture Report

Prepared: `2026-04-23`

This report covers the broader retrieval architecture around embeddings for `unified-llm-client`: how to add embeddings without disrupting the current flow, how retrieval should work, which retrieval mechanisms exist, how embeddings should be stored, and what should live inside this library versus the chatbot application.

## Executive Summary

- The least disruptive path is to add embeddings as a new stateless top-level verb, `client.embed()`, while keeping `complete()`, `stream()`, `conversation()`, session persistence, usage logging, prompt caching, and model discovery unchanged.
- Retrieval should not be bolted into the existing conversation flow directly. The cleaner design is:
  1. `client.embed()` in the core library
  2. retrieval and vector-store helpers as optional, separate modules
  3. application-level orchestration that performs retrieval before calling `complete()` or `conversation.send()`
- For this repo and its current Postgres / `DATABASE_URL` setup, the best first storage choice is app-owned Postgres with `pgvector`, plus lexical search in Postgres, rather than provider-hosted retrieval.
- The recommended production retrieval default is hybrid retrieval:
  - dense vector search for semantic matching
  - lexical search for exact terms, SKUs, names, and policy phrases
  - reranking on the merged candidates
- Multitenancy and data safety must be first-class in retrieval:
  - every stored vector should be scoped by `tenantId`
  - usually also `botId`
  - and by an explicit embedding profile / model id
- Current product scope for embeddings is Google Embedding 2 only in v1, with retrieval architecture kept provider-agnostic so the storage and search layers do not need to change later.

## Current Library Constraints

The current library already has a stable generation and persistence surface:

- `LLMClient.complete()`
- `LLMClient.stream()`
- `LLMClient.conversation()`
- `getUsage()` / `exportUsage()`
- `googleCaches.*`
- `models.listRemote({ provider })`

Important implications:

- OpenAI generation already runs through the stateless Responses API with library-owned history replay.
- Prompt caching is already generation-specific:
  - `providerOptions.openai.promptCaching`
  - `providerOptions.anthropic.cacheControl`
  - `providerOptions.google.promptCaching.cachedContent`
  - `client.googleCaches`
- `client.models.listRemote({ provider })` is already discovery-only and does not auto-register models into the routing registry.

Because of that, embeddings should not:

- alter `LLMRequestOptions`
- change how conversations are persisted
- piggyback on `providerOptions`
- piggyback on `googleCaches`
- auto-mutate the local model registry from remote discovery

## Recommended Design: Add Embeddings Without Interrupting Current Flow

### What should change

Add a new top-level stateless operation:

```ts
const result = await client.embed({
  input: "Refunds are available for 30 days.",
  provider: "google",
  model: "gemini-embedding-2",
});
```

Recommended core additions:

- canonical embedding request and response types
- `client.embed()`
- embedding-capable model metadata in the local registry
- provider adapter support for the selected Google Embedding 2 path
- model-kind validation so embedding models cannot be used with `complete()`

### What should not change

Do not change the semantics of:

- `complete()`
- `stream()`
- `conversation()`
- `SessionApi`
- `PostgresSessionStore`
- `PostgresUsageLogger`
- prompt-caching APIs
- remote model discovery behavior

### Why this is the safest rollout

This keeps the library architecture coherent:

- generation remains generation
- embeddings remain embeddings
- retrieval orchestration remains an application concern or an optional module

That is the lowest-risk path for a library that already has stable generation, sessions, and usage surfaces.

## How Retrieval Should Work

Retrieval should be a separate pipeline that runs before generation.

### Ingestion flow

1. Normalize and parse source content.
2. Split content into retrieval chunks.
3. Choose an embedding profile.
4. Call `client.embed()` with document-oriented embedding options.
5. Store:
   - chunk text
   - embedding vector
   - source metadata
   - tenant / bot scoping fields
   - embedding profile id
6. Build or refresh indexes.

### Query-time flow

1. Receive the user query.
2. Resolve the active embedding profile for the bot / tenant.
3. Call `client.embed()` with query-oriented embedding options.
4. Search the vector store.
5. Optionally run lexical search in parallel.
6. Merge and deduplicate candidates.
7. Optionally rerank the merged candidates.
8. Select the final context under a token budget.
9. Call `complete()` or `conversation.send()` with the retrieved context inserted into the prompt.

### Where retrieval belongs in this repo

Recommended layering:

- Core library:
  - `client.embed()`
  - embedding types
  - embedding model metadata
- Optional retrieval module:
  - retriever interfaces
  - Postgres / `pgvector` helpers
  - hybrid fusion helpers
  - rerank integration hooks
- Application layer:
  - chunking
  - source syncing
  - document lifecycle
  - authorization / multitenancy
  - prompt assembly

This keeps the core client small and avoids turning it into a full knowledge-base platform.

## Retrieval Mechanisms

Below are the main retrieval mechanisms that matter for this project.

### 1. Dense vector retrieval

This is standard embedding-based nearest-neighbor search.

How it works:

- embed each chunk into a dense vector
- embed the user query with the same model / profile
- return the nearest vectors by cosine similarity, inner product, or L2 distance

Why it matters:

- handles semantic similarity
- good for paraphrases and natural-language questions
- simplest baseline for RAG

Where it fits here:

- should be the first retrieval capability shipped
- should use the same embedding profile for documents and queries

### 2. Lexical / full-text retrieval

This is keyword-oriented retrieval over the raw text.

How it works:

- tokenize and index the text itself
- search by word overlap / lexeme matches

Why it matters:

- catches exact identifiers that dense retrieval may miss
- useful for SKUs, product codes, policy names, error strings, version numbers, proper nouns

Where it fits here:

- should live beside vector retrieval, not replace it
- easiest first implementation in this stack is Postgres full-text search

### 3. Hybrid retrieval

Hybrid retrieval combines vector search and keyword search.

Why it matters:

- dense search is better for meaning
- lexical search is better for exact tokens
- hybrid search is often the most robust default for production search

Practical implication:

- this should be the recommended default retrieval mode once the dense baseline works

### 4. Two-stage retrieval with reranking

This is a multi-stage pattern:

1. retrieve a broader candidate set
2. rerank those candidates with a stronger relevance model

Why it matters:

- improves final relevance
- lets you keep the initial search cheap and fast
- especially useful for user-facing chatbot answers

Practical implication:

- this should be the recommended production mode for higher-value bots
- it can be added after dense / hybrid retrieval is stable

### 5. Metadata-filtered retrieval

This is not optional in a multi-tenant SaaS system.

Examples:

- `tenantId`
- `botId`
- locale
- content type
- source id
- access tier
- publication status

Why it matters:

- avoids leaking cross-tenant content
- keeps results narrow and relevant
- reduces vector search noise before reranking

### 6. Hierarchical / document-aware retrieval

This is an application-level pattern rather than a provider primitive.

Examples:

- retrieve child chunks, then collapse to parent documents
- return one or two chunks per source instead of ten from the same file
- use section headers and source structure in ranking

Why it matters:

- avoids redundancy in prompts
- improves answer grounding
- gives better context variety under a fixed token budget

Recommended status:

- not needed in the first slice of library support
- useful in the chatbot app or in an optional retrieval module

## What Retrieval Mechanism Should We Actually Use?

Recommended rollout:

1. Dense retrieval first
2. Hybrid retrieval second
3. Reranking third

Reasoning:

- dense-only gets the embeddings flow working end to end
- hybrid improves robustness for real-world support and commerce queries
- reranking improves quality once the candidate-generation path is correct

Recommended default production mode after phase 2:

- hybrid retrieval + metadata filters

Recommended premium / higher-quality mode after phase 3:

- hybrid retrieval + metadata filters + rerank

## What CrewAI And LlamaIndex Do

These two frameworks are useful reference points because they solve adjacent problems in very different ways.

### CrewAI

CrewAI splits retrieval-related functionality into two higher-level systems:

- `Knowledge` for preloaded external sources
- `Memory` for runtime facts and agent context

What stands out in the current CrewAI docs:

- `Knowledge` is not folded into the core agent call surface. It is attached separately at the crew or agent level.
- Built-in knowledge storage is opinionated and defaults to ChromaDB-backed local storage, while a separate provider-neutral RAG client exists for direct vector-store control.
- Embeddings are configured independently from the chat model. CrewAI documents a separate `embedder` configuration and explicitly notes that knowledge defaults to OpenAI embeddings unless changed.
- `Memory` is a different subsystem again. It layers semantic retrieval with recency and importance scoring, supports scoped recall, and writes in the background before synchronizing reads.

What this means for us:

- CrewAI reinforces the idea that embeddings and retrieval should stay outside the raw generation request path.
- It also shows the value of separating long-lived knowledge retrieval from runtime memory, rather than forcing one abstraction to cover both.
- What we should not copy is the very opinionated built-in storage default. This library is lower-level and should avoid silently choosing a vector-store architecture for applications.

### LlamaIndex

LlamaIndex is much more modular and retrieval-centric.

What stands out in the current LlamaIndex docs:

- The ingestion path is explicit: load documents, transform them into nodes, enrich metadata, embed them, and optionally write them straight into a vector store through an `IngestionPipeline`.
- Vector storage is decoupled from the index through `StorageContext`, and the framework supports many vector databases instead of one default production store.
- Retrieval is treated as a first-class layer with metadata filters, hybrid query modes, router retrievers, recursive retrievers, and reranking postprocessors.
- Querying is composed from retrievers and postprocessors rather than hidden inside one monolithic chat call.

What this means for us:

- LlamaIndex reinforces the modular design already recommended in this report:
  - embeddings as one capability
  - storage as another
  - retrieval as another
  - reranking as another
- Its design is closer to what our optional retrieval module should look like than what the core `LLMClient` should become.
- What we should not copy is the full framework surface. This repo should expose primitives and a clean integration path, not a giant orchestration framework.

### Practical takeaway for this library

The right middle ground for `unified-llm-client` is:

- follow CrewAI in keeping retrieval concerns out of the core generation call path
- follow LlamaIndex in keeping ingestion, storage, retrieval, filters, and reranking modular
- keep the core library narrow with `client.embed()`
- place retrievers, Postgres / `pgvector` helpers, hybrid fusion, and rerank hooks in optional modules or the application layer

## How To Store Embeddings

### Recommended first storage choice: Postgres + `pgvector`

For this codebase, Postgres is the best first storage layer because:

- the repo already uses `DATABASE_URL`
- `PostgresSessionStore` and `PostgresUsageLogger` already exist
- multitenancy is already part of the design language
- keeping retrieval data in Postgres simplifies operational ownership

Why this is the best fit:

- one database for sessions, usage, chunk metadata, and vectors
- simple transactional ingest / delete flows
- tenant filters are straightforward
- lower operational complexity than adding a dedicated vector database immediately

### Storage model recommendation

Use a schema shaped around embedding profiles, sources, and chunks.

Recommended tables:

1. `embedding_profiles`
2. `knowledge_sources`
3. `knowledge_chunks`

Recommended `embedding_profiles` fields:

- `id`
- `tenant_id`
- `bot_id`
- `provider`
- `model`
- `dimensions`
- `distance_metric`
- `purpose_defaults`
- `created_at`
- `updated_at`

Recommended `knowledge_sources` fields:

- `id`
- `tenant_id`
- `bot_id`
- `source_type`
- `external_id`
- `title`
- `canonical_url`
- `checksum`
- `status`
- `metadata jsonb`
- `created_at`
- `updated_at`

Recommended `knowledge_chunks` fields:

- `id`
- `tenant_id`
- `bot_id`
- `source_id`
- `embedding_profile_id`
- `chunk_index`
- `text`
- `token_count`
- `metadata jsonb`
- `fts tsvector`
- `embedding`
- `created_at`
- `updated_at`

### Schema recommendation for vectors

If you plan to support multiple embedding models with different dimensions, prefer one of these patterns:

1. one table per embedding profile
2. one table per dimension family
3. one shared table with `embedding vector` plus partial / expression indexes per profile

For this project, the cleanest first production choice is:

- one shared chunks table
- explicit `embedding_profile_id`
- partial indexes per active embedding profile when dimensions differ

That fits the current library direction, where remote model discovery may surface embedding-capable models before they are routable. The database should track which embedding profiles are actually active, not every model a provider exposes remotely.

### Recommended indexes

For Postgres + `pgvector`:

- HNSW on the vector column for the active distance metric
- GIN on `fts`
- B-tree on:
  - `tenant_id`
  - `bot_id`
  - `source_id`
  - `embedding_profile_id`

Practical advice:

- start with cosine similarity unless you have a reason to prefer inner product
- start with HNSW for query-heavy workloads
- use IVFFlat only if build time / memory tradeoffs make HNSW unattractive

### Exact vs approximate search

`pgvector` supports both:

- exact nearest-neighbor search
- approximate nearest-neighbor search

Recommended guidance:

- exact search for small datasets and validation
- approximate indexed search for real production traffic

### Memory and scale notes

If storage pressure increases, `pgvector` also supports:

- `halfvec`
- binary quantization
- sparse vectors

These are useful later, but they should not be part of the first embeddings rollout unless benchmarks prove the need.

## How To Add Retrieval Without Breaking The Library Boundary

### Recommended library boundary

Put only these in the core package:

- embedding types
- `client.embed()`
- embedding model metadata
- provider adapters for embeddings

Put these in an optional retrieval module or separate subpath:

- Postgres chunk schema helpers
- retriever interfaces
- hybrid fusion helpers
- rerank adapters

### Suggested retrieval interfaces

These are architectural suggestions, not a requirement for the first slice.

```ts
export interface RetrievalQuery {
  botId?: string;
  embeddingProfileId: string;
  filters?: Record<string, unknown>;
  query: string;
  tenantId?: string;
  topK?: number;
}

export interface RetrievedChunk {
  chunkId: string;
  metadata?: Record<string, unknown>;
  score: number;
  sourceId: string;
  text: string;
}

export interface Retriever {
  search(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}

export interface Reranker {
  rerank(query: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]>;
}
```

Why this shape works:

- it does not alter `LLMClient.complete()`
- it does not force a storage engine
- it keeps multitenancy explicit
- it lets the chatbot app compose retrieval before generation

## Recommended Runtime Architecture For The Chatbot Widget

### Ingestion pipeline

Recommended:

1. fetch / parse source
2. normalize to clean text + metadata
3. chunk with overlap where needed
4. embed with `client.embed(... purpose: 'retrieval_document')`
5. write rows to Postgres
6. refresh indexes if needed

### Query pipeline

Recommended:

1. receive user query
2. load bot config
3. resolve active embedding profile
4. embed the query with `purpose: 'retrieval_query'`
5. run vector search
6. optionally run lexical search
7. fuse candidates
8. rerank top candidates
9. assemble prompt context
10. call `complete()` or `conversation.send()`

### Prompt assembly rules

Recommended:

- cap retrieved context by token budget
- deduplicate near-identical chunks
- limit chunks per source
- include source titles / metadata where useful
- keep system prompt and retrieval context separate

This is especially important because generation-side prompt caching is already in place. Retrieval context will often be query-specific, while system / policy / tool context may be cacheable.

## Hosted Retrieval Vs App-Owned Retrieval

There are two broad approaches.

### Option A: provider-hosted retrieval

Examples:

- OpenAI Retrieval / File Search / Vector Stores

Pros:

- less infrastructure to manage
- provider handles chunking, embedding, and indexing

Cons:

- difficult to keep provider-agnostic
- couples retrieval tightly to one provider
- retrieval behavior can diverge from your own embedding / storage strategy
- harder to align with the current library’s provider-agnostic session and conversation model

Recommendation for this repo:

- do not make provider-hosted retrieval the core path in v1

### Option B: app-owned retrieval

Examples:

- Postgres + `pgvector`
- dedicated vector DB plus your own orchestration

Pros:

- provider-agnostic
- easier multitenant controls
- easier cross-provider embedding / generation combinations
- fits the current library structure better

Cons:

- more code and operational ownership

Recommendation for this repo:

- make app-owned retrieval the primary architecture

## When To Move Beyond Postgres

Start with Postgres + `pgvector` if:

- you already run Postgres
- you want one operational plane
- your first goal is product correctness, not extreme ANN throughput

Consider a dedicated vector database later if:

- corpus size or QPS outgrows comfortable Postgres tuning
- you want built-in hybrid / rerank / multimodal workflows
- you need operational independence between transactional and retrieval workloads

If that happens, keep the library API stable:

- `client.embed()` stays the same
- only the retrieval backend changes

## Recommended Delivery Plan

### Phase 1: embeddings only

- add canonical embedding request / response types
- add `client.embed()`
- add Google Embedding 2 support
- add model-kind metadata

### Phase 2: Postgres retrieval foundation

- add chunk / source / profile tables in the chatbot app
- add vector search with `pgvector`
- add lexical search with Postgres FTS
- add metadata filtering

### Phase 3: hybrid retrieval

- merge dense and lexical candidates
- tune weighting
- add retrieval evaluation fixtures

### Phase 4: reranking

- add optional reranker integration
- rerank merged candidates before prompt assembly

### Phase 5: advanced retrieval

- hierarchical chunk selection
- profile migrations
- background reindex jobs
- optional dedicated vector DB backend

## Bottom Line

The best way to add embeddings without interrupting the current library flow is:

- add `client.embed()` as a separate stateless core API
- keep retrieval orchestration outside `complete()` / `conversation()`
- use app-owned retrieval as the default architecture
- store embeddings in Postgres + `pgvector` first
- ship dense retrieval first, then hybrid, then rerank
- keep prompt caching and retrieval as separate concerns
- keep remote model discovery discovery-only

That path matches the current codebase, the chatbot widget use case, and the current provider / storage ecosystem.

## Source Links

- OpenAI embeddings API reference: https://developers.openai.com/api/reference/resources/embeddings/methods/create
- OpenAI retrieval guide: https://developers.openai.com/api/docs/guides/retrieval
- OpenAI file search guide: https://platform.openai.com/docs/guides/tools-file-search/
- Gemini embeddings API reference: https://ai.google.dev/api/embeddings
- Anthropic embeddings guide: https://platform.claude.com/docs/en/build-with-claude/embeddings
- CrewAI knowledge docs: https://docs.crewai.com/en/concepts/knowledge
- CrewAI memory docs: https://docs.crewai.com/en/concepts/memory
- LlamaIndex VectorStoreIndex guide: https://developers.llamaindex.ai/python/framework/module_guides/indexing/vector_store_index/
- LlamaIndex Ingestion Pipeline guide: https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/
- LlamaIndex vector store API reference: https://developers.llamaindex.ai/python/framework-api-reference/storage/vector_store/
- LlamaIndex router retriever guide: https://developers.llamaindex.ai/python/framework/integrations/retrievers/router_retriever/
- LlamaIndex LLM rerank reference: https://developers.llamaindex.ai/python/framework-api-reference/postprocessor/llm_rerank/
- `pgvector` official README: https://github.com/pgvector/pgvector
- PostgreSQL full-text search index docs: https://www.postgresql.org/docs/current/textsearch-indexes.html
- Pinecone hybrid search docs: https://docs.pinecone.io/guides/search/hybrid-search
- Weaviate hybrid search docs: https://docs.weaviate.io/weaviate/search/hybrid
- Cohere rerank API reference: https://docs.cohere.com/reference/rerank
