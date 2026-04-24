# Embeddings Integration Report

Prepared: `2026-04-22`  
Updated: `2026-04-25`

This report describes how embeddings should be added to `unified-llm-client` for the chatbot widget product.

For the broader system design around retrieval flows, storage, hybrid search, reranking, and rollout sequencing, see [EMBEDDINGS_RETRIEVAL_ARCHITECTURE_REPORT.md](./EMBEDDINGS_RETRIEVAL_ARCHITECTURE_REPORT.md).  
For the concrete multitenant retrieval, safety, and scaling plan, see [RETRIEVAL_API_INTEGRATION_REPORT.md](./RETRIEVAL_API_INTEGRATION_REPORT.md).
For a cross-check of post-v1 follow-up suggestions such as lightweight stores, chunking helpers, Gemini text batching, extraction helpers, and OpenAI embeddings, see [EMBEDDINGS_REVIEW_CROSSCHECK.md](./EMBEDDINGS_REVIEW_CROSSCHECK.md).

## Executive Summary

- The chatbot widget needs embeddings for ingest-time knowledge indexing and runtime query retrieval.
- The library now ships a first-class embeddings surface through `client.embed()`.
- The project decision for v1 is now explicit:
  - support the Google Embedding 2 path only
  - defer OpenAI embeddings
  - reject Anthropic embeddings
- The reason for that scope decision is product-driven:
  - the widget needs native PDF and file-oriented knowledge ingestion
  - OpenAI’s currently documented embedding models are text-only
  - Anthropic does not provide a first-party embeddings API
- The clean library shape is still:
  - keep `client.embed()` as a top-level stateless operation
  - keep retrieval helpers outside `LLMClient`
  - keep retrieval, chunking, vector storage, citations, and ingestion jobs outside the core `LLMClient`

## Why This Is Needed For The Chatbot Widget

The PRD already depends on embeddings in two places:

- ingest-time knowledge indexing
- runtime query retrieval before generation

The product implication is straightforward:

- the widget backend needs one stable way to embed knowledge chunks
- the widget backend needs the same embedding profile for user-query retrieval
- both sides must stay in one embedding space for the active index

## Current Repo State

The current codebase now exposes the first embeddings slice:

- `LLMClient` exposes `embed()` alongside `complete()`, `stream()`, `conversation()`, usage export, and `googleCaches`
- the model registry now distinguishes embedding models from completion models
- the Gemini adapter implements the selected Google Embedding 2 transport
- canonical embedding request/response types now live in `src/types.ts`
- the package now ships optional retrieval primitives in `src/retrieval.ts`
- the retrieval package now includes `createInMemoryKnowledgeStore()` for demos, tests, and single-process apps
- the retrieval module now includes `PostgresKnowledgeStore` for app-owned `pgvector` storage, strict filtered search, schema bootstrap helpers, active-profile helpers, and source reindex helpers
- reusable text cleanup and splitting helpers now ship through `unified-llm-client/chunking`
- dense and hybrid retrievers now accept optional rerank hooks
- `formatRetrievedContext()` now supports explicit score-display modes so retrieval scores are not mislabeled as probabilities in logs or UI text
- `client.models.listRemote({ provider })` now exists for discovery, but it still does not auto-register new models into the local routing registry
- live embedding smoke coverage now exists under `pnpm test:embeddings:live`

What is still intentionally missing:

- full ingestion queue orchestration
- provider-hosted rerank integrations
- automatic retrieval inside `complete()` or `conversation()`

## Provider Decision For V1

### Google

Google is the only embeddings provider in scope for the first release.

Project decision:

- target Google Embedding 2 for v1
- shape the public API so it can support the widget’s file/PDF-oriented embedding use case
- keep the exact retrieval/storage pipeline in the widget app, not in the core library

Practical implication:

- Google becomes the single supported embedding provider in the first slice
- the library API should be designed around the Google-first use case rather than a lowest-common-denominator text-only abstraction

### OpenAI

OpenAI is deferred for embeddings in v1.

Why:

- the currently documented OpenAI embedding model pages describe text embeddings only
- the widget’s current requirement is native PDF and file-oriented ingestion
- supporting OpenAI now would complicate the public API and test matrix without serving the immediate product need

OpenAI generation support remains unchanged. This decision applies only to embeddings.

### Anthropic

Anthropic remains unsupported for embeddings.

Anthropic’s official embeddings guide still points users to external providers rather than a first-party Anthropic embeddings API.

## Recommended Product Decision

### Launch decision

Add embeddings to the unified library with this first-release scope:

1. Support Google Embedding 2 only
2. Reject `provider: 'openai'` in `client.embed()` for v1
3. Reject `provider: 'anthropic'` in `client.embed()`
4. Keep embedding generation separate from chat-generation provider choice

Current implementation status:

- `client.embed()` is shipped
- `gemini-embedding-2` is in the local registry as an embedding model
- unsupported providers fail clearly
- optional retrieval helpers now ship through the package root and `unified-llm-client/retrieval`
- `PostgresKnowledgeStore` now ships for the recommended `Postgres + pgvector` architecture
- live validation now exists for Gemini text embeddings, Postgres-backed retrieval smoke, and an opt-in tiny-PDF embedding smoke
- current public Gemini embeddings docs explicitly cover `gemini-embedding-2` multimodal inputs, including PDF, while the safest batching optimization target remains text-only multi-input requests

### Critical design rule

Embedding generation and answer generation are separate concerns.

The chatbot can still use:

- Google for embeddings
- Anthropic or OpenAI for answer generation

That is the correct architecture. The unified library should preserve it rather than force one provider for both operations.

## Recommended Public API

The cleanest fit is still a first-class `client.embed()` method.

### Proposed request shape

```ts
export type EmbeddingProvider = 'google';

export type EmbeddingPurpose =
  | 'retrieval_document'
  | 'retrieval_query'
  | 'semantic_similarity'
  | 'classification'
  | 'clustering';

export interface EmbeddingRequestOptions {
  input: CanonicalPart[] | string | string[];
  model?: string;
  provider?: EmbeddingProvider;
  signal?: AbortSignal;

  dimensions?: number;
  purpose?: EmbeddingPurpose;

  providerOptions?: {
    google?: {
      taskInstruction?: string;
      title?: string;
    };
  };

  // For tracing and usage only, not routing semantics.
  botId?: string;
  tenantId?: string;
}
```

### Proposed response shape

```ts
export interface EmbeddingResultItem {
  index: number;
  values: number[];
}

export interface EmbeddingUsageMetrics {
  cost?: string;
  costUSD?: number;
  estimated?: boolean;
  inputTokens?: number;
}

export interface EmbeddingResponse {
  embeddings: EmbeddingResultItem[];
  model: string;
  provider: EmbeddingProvider;
  raw: unknown;
  usage?: EmbeddingUsageMetrics;
}
```

### Why this shape fits the repo

- `LLMClient` already exposes top-level verbs
- embeddings are a first-class operation, not generation metadata
- the input shape can stay aligned with the widget’s Google-first file/document use case
- `tenantId` and `botId` can flow into logging without turning `client.embed()` into a retrieval router

## Recommended Mapping Rules

### Google mapping

Map canonical options to the selected Google Embedding 2 transport used by the widget stack.

The library contract should preserve these concepts:

- `model`
- `input`
- `dimensions`
- query/document intent through `purpose` or `taskInstruction`
- file/document metadata such as `title` when the selected transport supports it

The important design rule is not the exact wire field names. It is keeping the public API stable while the adapter maps to the verified Google Embedding 2 endpoint chosen for the product.

### OpenAI mapping

There should be no OpenAI mapping in v1.

The library should throw:

```ts
throw new ProviderCapabilityError(
  'OpenAI embeddings are deferred in v1. The current embeddings scope is Google only.',
  { provider: 'openai' },
);
```

### Anthropic mapping

There should be no Anthropic mapping in v1.

The library should throw:

```ts
throw new ProviderCapabilityError(
  'Anthropic does not provide a first-party embeddings API.',
  { provider: 'anthropic' },
);
```

## Widget-Specific Architecture Implications

### 1. Query and document embeddings must match

This is still the most important implementation constraint.

You cannot safely:

- embed stored knowledge chunks with one Google embedding profile
- then embed the live user query with a different profile
- and expect one `pgvector` index to return meaningful similarity scores

Embedding spaces are profile-specific.

That means the app needs:

1. one active embedding profile per bot
2. every stored vector tagged with its profile id
3. runtime query embedding forced to the same profile id

### 2. The library should not own chunking or vector storage

This repo should expose embedding generation, not become the knowledge-base pipeline itself.

Keep these concerns outside the unified client:

- PDF parsing
- URL crawling
- chunking strategy
- `pgvector` schema migration
- similarity search SQL
- ingestion retries and progress tracking

The library should only provide the provider-normalized embedding call that the widget backend uses.

### 3. Introduce an embedding profile in the widget app

For the chatbot platform, use an application-level profile concept such as:

```ts
interface EmbeddingProfile {
  dimensions?: number;
  id: string;
  model: string;
  provider: 'google';
}
```

Recommended behavior:

- each bot has one active embedding profile
- every stored vector records the profile id used to produce it
- runtime query embedding uses the same profile id
- profile swaps happen through a background reindex job, then an atomic cutover

### 4. Query/document purpose still matters

For the widget:

- use `retrieval_document` when embedding knowledge chunks
- use `retrieval_query` when embedding user messages for search

That distinction should be represented in the library surface.

## Model Registry Recommendations

The current registry only models generative models.

Embeddings add a new kind of model, so the report recommends extending the registry metadata rather than treating embedding models as normal chat models.

### Recommended metadata additions

```ts
interface ModelInfo {
  kind?: 'completion' | 'embedding';
  embeddingDimensions?: {
    default: number;
    max?: number;
    min?: number;
    recommended?: number[];
  };
  maxInputTokens?: number;
  supportedInputModalities?: Array<'text' | 'document' | 'image' | 'audio' | 'video'>;
}
```

Recommended new registry entry for v1:

- `gemini-embedding-2`

### Why `kind` matters

Without a model-kind distinction:

- a caller could accidentally pass an embedding model into `complete()`
- or pass a generative model into `embed()`

That should fail in the library before the provider boundary.

## Usage And Cost Tracking Recommendations

Google embedding usage reporting should be modeled conservatively.

Recommended v1 handling:

- expose `usage.inputTokens` only when the provider returns authoritative usage
- otherwise leave usage empty or mark it as estimated
- do not pretend cost is exact unless the provider returns enough data to compute it correctly

Suggested canonical behavior:

```ts
usage: {
  estimated: true,
  inputTokens: estimatedCount,
  costUSD: estimatedCost,
}
```

if the implementation chooses to estimate.

## Recommended Delivery Order

1. Add canonical embedding request/response types in `src/types.ts`
2. Add `client.embed()` in `src/client.ts`
3. Add Google Embedding 2 adapter support in `src/providers/gemini.ts`
4. Extend model metadata for embedding models in `src/models/prices.json`
5. Add conservative usage/cost handling for Google embedding responses
6. Add unit tests for request mapping, response mapping, model-kind validation, and client routing
7. Add live tests behind an opt-in gate for Google embeddings
8. Update docs with widget-oriented examples for ingest-time document embeddings and runtime query embeddings

## Recommended Tests

- Google adapter test for embedding request mapping
- Google adapter test for `purpose` / task-instruction mapping
- Google adapter test for `dimensions`
- Google adapter test for document/file-oriented input mapping on the selected transport
- Client routing test for `client.embed()`
- Model registry test that embedding models cannot be used for `complete()`
- Client test that `openai` embeddings are rejected in v1
- Client test that `anthropic` embeddings are rejected
- Live Google embedding smoke test

## Open Questions

- Which exact Google Embedding 2 transport should the adapter target first in this repo?
- Should the first release expose only `client.embed()` or also optional Google batch helpers later?
- Should Google embedding cost be estimated in-library or left undefined until provider usage is available?
- Do we want file/document capability in the first adapter patch, or text first with the request shape already prepared for file support?

## Bottom Line

Embeddings belong in this library, but as a separate first-class API from completions.

The correct near-term design is:

- `client.embed()`
- Google Embedding 2 only in v1
- OpenAI deferred for embeddings
- Anthropic unsupported for embeddings
- embedding generation independent from answer-generation provider choice
- widget app manages chunking, vector storage, and embedding-profile rollouts

That shape matches the current product decision and the chatbot widget architecture already described in the PRD.

## Source Links

- OpenAI `text-embedding-3-large` model page: https://developers.openai.com/api/docs/models/text-embedding-3-large
- OpenAI `text-embedding-3-small` model page: https://developers.openai.com/api/docs/models/text-embedding-3-small
- Gemini embeddings guide: https://ai.google.dev/gemini-api/docs/embeddings
- Gemini embeddings API reference: https://ai.google.dev/api/embeddings
- Vertex AI multimodal embeddings: https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings
- Anthropic embeddings guide: https://platform.claude.com/docs/en/build-with-claude/embeddings
