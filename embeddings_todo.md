# Embeddings TODO

Prepared: `2026-04-24`  
Source documents:

- [docs/EMBEDDINGS_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/EMBEDDINGS_REPORT.md)
- [docs/EMBEDDINGS_RETRIEVAL_ARCHITECTURE_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/EMBEDDINGS_RETRIEVAL_ARCHITECTURE_REPORT.md)
- [docs/RETRIEVAL_API_INTEGRATION_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/RETRIEVAL_API_INTEGRATION_REPORT.md)
- [docs/another_report_on_embeddings.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/another_report_on_embeddings.md)

## Goal

Ship first-class embeddings support in `unified-llm-client` without breaking the current generation, conversation, session, caching, routing, or model-discovery flow.

Planned direction:

- add `client.embed()` as a new stateless top-level API
- keep retrieval explicit and outside `complete()` / `conversation()`
- support Google Embedding 2 only in v1
- shape the request surface for the widget’s file/PDF-oriented use case
- keep tenant isolation and retrieval policy in the app layer or an optional retrieval module

## Current Status

- [x] Embeddings and retrieval research is documented in [docs/EMBEDDINGS_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/EMBEDDINGS_REPORT.md)
- [x] Broader retrieval architecture and storage guidance is documented in [docs/EMBEDDINGS_RETRIEVAL_ARCHITECTURE_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/EMBEDDINGS_RETRIEVAL_ARCHITECTURE_REPORT.md)
- [x] Multitenant retrieval, safety, and scaling guidance is documented in [docs/RETRIEVAL_API_INTEGRATION_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/RETRIEVAL_API_INTEGRATION_REPORT.md)
- [x] `LLMClient` now exposes `client.embed()` for the Google-only v1 scope
- [x] The model registry now classifies embedding models separately from completion models
- [x] The Gemini adapter now exposes the selected Google Embedding 2 transport
- [x] The package now exposes retrieval primitives and helper interfaces through the main package and `unified-llm-client/retrieval`
- [x] The v1 plan is Google-only for embeddings, with OpenAI deferred and Anthropic unsupported

## Design Constraints

- Do not change the semantics of `complete()`, `stream()`, or `conversation()`.
- Do not hide retrieval as a side effect inside generation APIs.
- Do not move vector storage, chunking, or ingestion queues into the core `LLMClient`.
- Do not mix vectors from different embedding models, dimensions, or task instructions in the same active profile.
- Do not trust client-supplied tenant scope for retrieval filters.
- Do not widen the provider surface beyond Google Embedding 2 in v1.
- Do not promise file/document semantics beyond the selected Google Embedding 2 transport.

## Phase 1 - Embedding Request Surface

### EMB-01 Canonical embedding types
Priority: `P0`

- [x] Add `EmbeddingProvider`
- [x] Add `EmbeddingPurpose`
- [x] Add `EmbeddingRequestOptions`
- [x] Add `EmbeddingResponse`
- [x] Add `EmbeddingResultItem`
- [x] Add `EmbeddingUsageMetrics`
- [x] Shape the v1 request surface for Google-first file/document inputs without coupling retrieval into the core client
- [x] Keep `tenantId` and `botId` optional and use them for logging/trace context only
- [x] Export all embedding types from the package root

Acceptance criteria:

- TypeScript users can import embedding types from `unified-llm-client`
- The generation request surface remains backward compatible
- The public API matches the Google-only v1 scope without hardwiring retrieval logic into `LLMClient`

### EMB-02 `LLMClient.embed()` public API
Priority: `P0`

- [x] Add `defaultEmbeddingModel` and `defaultEmbeddingProvider` to `LLMClientOptions`
- [x] Add `client.embed(options)` to `LLMClient`
- [x] Implement embedding request resolution rules
- [x] Default the embedding provider path to Google in v1
- [x] Add capability errors for unsupported provider / model / input combinations
- [x] Add mock embedding support to `LLMClient.mock()`

Acceptance criteria:

- `client.embed()` works without changing existing completion callers
- Generation and embedding providers can still differ in app flows because embeddings stay separate from generation, even though only Google is supported for embeddings in v1
- Test suites can queue deterministic mock embedding responses

## Phase 2 - Model Registry And Validation

### EMB-03 Model registry metadata
Priority: `P0`

- [x] Extend `ModelInfo` with `kind: 'completion' | 'embedding'`
- [x] Add embedding metadata fields:
  - [x] dimensions
  - [x] supported input modalities
  - [ ] optional task/purpose notes
- [x] Add registry helpers for model-kind assertions
- [x] Add the verified Google Embedding 2 entry for the first release
- [x] Keep missing `kind` backward compatible by treating legacy entries as completion models

Acceptance criteria:

- `complete()` rejects embedding-only models
- `embed()` rejects completion-only models
- The registry can describe embedding capabilities cleanly

### EMB-04 Usage and cost policy for embeddings
Priority: `P1`

- [x] Decide whether embedding usage is response-only in v1 or also persisted through `UsageLogger`
- [ ] If persisted, add an explicit `operation` field to usage events/schema
- [x] Parse provider token usage when returned
- [x] Mark estimated cost explicitly when provider metadata is incomplete
- [x] Avoid faking completion-style `finishReason` for embedding requests

Acceptance criteria:

- Embedding usage does not corrupt existing completion analytics
- Cost reporting is explicit about exact vs estimated values

Current implementation note:

- Embedding usage is response-only in v1. It is not yet persisted through `UsageLogger`.
- The current Google embedding response mapping returns `usage.inputTokens` when the provider returns `promptTokenCount`.
- Cost is only included when the model registry has a non-zero authoritative input price. The current Google embedding model entry leaves cost unset rather than pretending it is exact.

## Phase 3 - Provider Adapters

### EMB-05 Google Embedding 2 transport
Priority: `P0`

- [x] Implement the selected Google Embedding 2 transport in `src/providers/gemini.ts`
- [x] Normalize Google embedding model names consistently with existing provider naming behavior
- [x] Map canonical purpose/task hints where the selected transport supports them
- [x] Support the widget’s file/document-oriented input shape on the selected transport
- [x] Parse returned embeddings and any usage metadata the provider exposes
- [x] Keep unsupported modality combinations behind clear capability errors

Acceptance criteria:

- Google Embedding 2 requests work on the selected transport
- Usage is mapped conservatively into canonical embedding metrics
- Existing Gemini generation and cache behavior remains unchanged

### EMB-06 Unsupported-provider handling
Priority: `P0`

- [x] Reject `provider: 'openai'` in `client.embed()` for v1
- [x] Reject `provider: 'anthropic'` in `client.embed()`
- [x] Surface clear capability errors that describe the Google-only v1 scope
- [x] Document deferred-provider expansion separately from the first release

Acceptance criteria:

- OpenAI embedding attempts fail clearly and predictably in v1
- Anthropic embedding attempts fail clearly and predictably in v1

### EMB-07 File / PDF support on the Google path
Priority: `P0`

- [x] Finalize how file and document inputs map into the selected Google Embedding 2 transport
- [x] Add capability metadata for supported file/document modalities
- [x] Add request validation for unsupported file combinations or limits
- [x] Add file/PDF-focused adapter coverage
- [x] Add live file/PDF smoke validation behind an opt-in gate

Acceptance criteria:

- The first release actually serves the widget’s PDF/file ingestion requirement

Current implementation note:

- `client.embed()` now validates positive integer dimensions, enforces model modality metadata, restricts `providerOptions.google.title` to `retrieval_document`, and rejects mixed or multi-file binary inputs within a single embedding item.
- Live file/PDF validation now ships in `test/embeddings_test/embeddings.live.test.ts` and is enabled with `GEMINI_EMBEDDING_PDF_LIVE=1`.

## Phase 4 - Retrieval Primitives

### EMB-09 Retrieval interfaces
Priority: `P0`

- [x] Define `KnowledgeStore` interface
- [x] Define `Retriever` interface
- [x] Define `RetrievalResult`, `RetrievalFilter`, and citation/result metadata types
- [x] Define `formatRetrievedContext()` output contract
- [x] Keep retrieval primitives separate from `LLMClient`

Acceptance criteria:

- Retrieval orchestration can be composed around `client.embed()`
- Retrieval types stay provider-agnostic and tenant-aware

### EMB-10 Postgres knowledge store helpers
Priority: `P1`

- [x] Add optional helpers for Postgres-backed knowledge storage
- [x] Define or document tables for:
  - [x] `knowledge_spaces`
  - [x] `embedding_profiles`
  - [x] `knowledge_sources`
  - [x] `knowledge_chunks`
- [x] Add vector-query helper methods with explicit filters
- [x] Add result mapping that preserves citations and source metadata

Acceptance criteria:

- Consumers can build app-owned retrieval on Postgres + `pgvector` without rewriting every primitive

Current implementation note:

- `PostgresKnowledgeStore` now ships in `src/retrieval.ts` with `ensureSchema()`, `searchByEmbedding()`, `searchByText()`, and upsert helpers for spaces, profiles, sources, and chunks.
- The generated schema uses `knowledge_spaces`, `embedding_profiles`, `knowledge_sources`, and `knowledge_chunks` by default, and supports custom schema/table names.
- Dense and lexical queries require strict `tenantId`, `botId`, `knowledgeSpaceId`, and `embeddingProfileId` filters before they will run.
- `createPgvectorHnswIndexSql()` is included to help consumers create per-profile HNSW indexes when dimensions differ across embedding profiles.

### EMB-11 Dense and hybrid retrievers
Priority: `P1`

- [x] Add `createDenseRetriever()`
- [x] Add `createHybridRetriever()`
- [x] Add lexical-search merge helpers
- [x] Add optional rerank hook points
- [x] Add token-budget-aware context formatting helpers

Acceptance criteria:

- Retrieval can run as explicit app orchestration before generation
- Dense retrieval works first; hybrid retrieval is additive

Current implementation note:

- `createDenseRetriever()`, `createHybridRetriever()`, `mergeRetrievalCandidates()`, and `formatRetrievedContext()` now ship in `src/retrieval.ts`.
- Dense and hybrid retrievers now accept optional rerank hooks without moving reranking into `LLMClient`.
- Retrieval stays outside `LLMClient`; callers still orchestrate retrieval explicitly before `complete()` or `conversation.send()`.
- The current helper layer still stops short of provider-hosted rerank APIs. It exposes hook points only.

## Phase 5 - Safety, Isolation, And Scale

### EMB-12 Multitenant isolation
Priority: `P0`

- [x] Enforce retrieval filters by:
  - [x] `tenant_id`
  - [x] `bot_id`
  - [x] `knowledge_space_id`
  - [x] `embedding_profile_id`
- [x] Document server-side scope derivation from auth context
- [x] Document Postgres RLS as a defense-in-depth layer
- [x] Fail closed when retrieval fails
- [x] Never broaden scope as a fallback

Acceptance criteria:

- Cross-tenant or cross-bot leakage is blocked by both application filters and database policy

### EMB-13 Immutable embedding profiles and reindexing
Priority: `P0`

- [x] Treat embedding profiles as immutable
- [x] Add active-profile pointer semantics
- [x] Define blue/green reindex rollout
- [x] Prevent mixed-model retrieval by requiring an exact profile match
- [x] Document reindex triggers when model, dimensions, or task instructions change

Acceptance criteria:

- Switching embedding settings does not corrupt live retrieval

Current implementation note:

- `PostgresKnowledgeStore.upsertEmbeddingProfile()` now rejects immutable profile-shape changes for an existing profile id.
- `knowledge_spaces.active_embedding_profile_id`, `activateEmbeddingProfile()`, and `getActiveEmbeddingProfile()` now support explicit active-profile cutover semantics.
- `markKnowledgeSourcesNeedingReindex()` now gives the app layer a concrete blue/green rollout helper for profile swaps.

### EMB-14 Reliability and operational limits
Priority: `P1`

- [x] Define ingestion status model:
  - [x] `queued`
  - [x] `processing`
  - [x] `ready`
  - [x] `failed`
  - [x] `needs_reindex`
- [x] Add idempotency guidance for re-runs and worker retries
- [x] Add checksum guidance for sources
- [x] Define hot-path limits:
  - [x] max chunk size
  - [x] max `topK`
  - [x] max rerank set
  - [x] max retrieval context tokens
  - [x] max concurrent embed jobs per tenant
- [x] Define retrieval-specific observability metrics

Acceptance criteria:

- Embedding and retrieval traffic can scale without blocking chat traffic or corrupting source state

Current implementation note:

- The Postgres schema and types now expose the ingestion lifecycle directly through `KnowledgeSourceStatus` and source records.
- Source records already carry `checksum`, `progressPercent`, and `errorMessage`, and the store now exposes `listKnowledgeSources()` plus `markKnowledgeSourcesNeedingReindex()` for app-side workers.
- The operational limits, idempotency guidance, and observability guidance remain documented in the embeddings architecture reports rather than hidden inside `LLMClient`.

## Phase 6 - Tests, Docs, And Validation

### EMB-15 Unit tests
Priority: `P0`

- [x] Add client tests for embedding resolution and model-kind validation
- [x] Add Google adapter tests for the selected Embedding 2 transport
- [x] Add error tests for unsupported providers and unsupported input modalities
- [x] Add retrieval helper tests if retrieval primitives ship in the package
- [x] Add Postgres knowledge-store helper tests

Acceptance criteria:

- Embedding behavior is covered without depending on live provider access

### EMB-16 Live tests
Priority: `P1`

- [x] Add `LIVE_TESTS=1` embedding smoke coverage
- [x] Validate the selected Google Embedding 2 path with real keys
- [x] Validate file/PDF embedding behavior on the selected Google path
- [x] Add optional Postgres retrieval smoke coverage if retrieval helpers ship

Acceptance criteria:

- Real-provider embedding calls are validated without destabilizing default CI

### EMB-17 Documentation and examples
Priority: `P0`

- [x] Update README with a minimal `client.embed()` example
- [x] Add docs for embedding model selection and profile consistency
- [x] Add retrieval examples showing:
  - [x] query embedding
  - [x] scoped retrieval
  - [x] prompt assembly
- [x] Document that retrieval remains explicit app orchestration
- [x] Add docs for `PostgresKnowledgeStore`
- [x] Document what is intentionally out of scope for the core library

Acceptance criteria:

- A consumer can understand how embeddings fit with the existing generation APIs

## Recommended Delivery Order

1. [x] EMB-01 canonical embedding types
2. [x] EMB-02 `LLMClient.embed()` public API
3. [x] EMB-03 model registry metadata
4. [x] EMB-05 Google Embedding 2 transport
5. [x] EMB-06 unsupported-provider handling
6. [x] EMB-07 file / PDF support on the Google path
7. [x] EMB-15 unit tests
8. [x] EMB-17 docs and examples
9. [x] EMB-04 usage and cost policy
10. [x] EMB-09 retrieval interfaces
11. [x] EMB-10 Postgres knowledge store helpers
12. [x] EMB-11 dense and hybrid retrievers
13. [x] EMB-12 to EMB-14 safety, isolation, and scale hardening
14. [x] EMB-16 live tests

Current verification note:

- Local validation is green for `pnpm test`, `pnpm lint`, `pnpm build`, `pnpm sizecheck`, and `pnpm docs:build`.
- Real-provider validation passed with `LIVE_TESTS=1 pnpm test:embeddings:live`.
- Real Gemini text embedding, Postgres-backed dense retrieval, and the gated tiny-PDF embedding smoke all passed against the credentials in `.env`.

## Open Questions

- [x] The current first-release target is the Google Embedding 2 `embedContent` path implemented in `src/providers/gemini.ts`.
- [ ] Should embedding usage be persisted in `UsageLogger` in v1, or returned in responses only?
- [x] Retrieval helpers now ship both from the main package root and the `unified-llm-client/retrieval` subpath.
- [ ] Do we want user-private retrieval in the initial widget integration, or only shared bot-level knowledge?
