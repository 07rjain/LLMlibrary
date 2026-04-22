# Embeddings Integration Report

Prepared: `2026-04-22`

This report describes how embeddings should be added to `unified-llm-client` to support the chatbot widget product defined in `chatbot_widget_PRD.md`.

## Executive Summary

- The chatbot widget PRD already assumes runtime query embeddings and `pgvector` retrieval in the chat path, especially in the request lifecycle described in `chatbot_widget_PRD.md`.
- The current library has no embeddings surface. It only exposes completion, streaming, conversations, usage logging, session APIs, and Gemini cache management.
- OpenAI and Google Gemini both have first-party embeddings APIs today.
- Anthropic still does not offer a first-party embeddings API. Anthropic’s official embeddings guide points users to external providers such as Voyage AI.
- The recommended launch shape for this library is:
  - add a first-class `client.embed()` API
  - support `openai` and `google` in the first slice
  - reject `provider: 'anthropic'` with `ProviderCapabilityError`
  - keep embedding provider selection independent from chat-generation provider selection

## Why This Is Needed For The Chatbot Widget

The PRD already depends on embeddings in two important places:

- Query-time retrieval:
  `chatbot_widget_PRD.md` describes embedding the user message, running `pgvector` similarity search, and then assembling the final Anthropic prompt from retrieved chunks and live context.
- Provider fallback:
  the assumptions section currently says “Gemini Embedding 2 API” is the primary path and `text-embedding-3-large` is the fallback.

The product implication is straightforward:

- the widget backend needs a stable way to embed knowledge chunks at ingest time
- the widget backend needs a stable way to embed the end-user query at runtime
- both sides must use the same embedding space for a given search index

## Current Repo State

The current codebase does not yet expose embeddings:

- `LLMClient` currently exposes `complete()`, `stream()`, `conversation()`, usage export, and `googleCaches` in [src/client.ts](../src/client.ts).
- the model registry only contains generative models in [src/models/prices.json](../src/models/prices.json)
- provider adapters only implement text generation, streaming, token counting, and Gemini cache lifecycle
- there is no canonical embedding request/response type in [src/types.ts](../src/types.ts)

This means the chatbot platform would currently need a second embeddings client outside this library, which defeats the purpose of a unified provider layer.

## Provider Reality As Of April 22, 2026

### OpenAI

OpenAI supports first-party embeddings through `POST /v1/embeddings`.

Relevant current facts from the official docs:

- recommended current models include `text-embedding-3-small` and `text-embedding-3-large`
- the endpoint accepts one string or an array of strings
- `dimensions` is supported on `text-embedding-3` models
- the response includes token usage, which is useful for accurate cost reporting

Implication for this library:

- OpenAI embeddings fit naturally into a unified `embed()` surface
- OpenAI is a valid fallback for the widget if Gemini embedding behavior changes

### Google Gemini

Gemini supports first-party embeddings with `gemini-embedding-001`.

Relevant current facts from the official docs:

- the interactive endpoint is `models.embedContent`
- Gemini also exposes `models.batchEmbedContents` and `asyncBatchEmbedContent`
- Gemini supports retrieval-aware hints such as `RETRIEVAL_QUERY` and `RETRIEVAL_DOCUMENT`
- Gemini supports `outputDimensionality`
- Gemini’s embedding response shape does not expose request usage counts the way OpenAI does

Implication for this library:

- Gemini should be the primary embeddings provider for the widget if that remains the product choice
- retrieval-oriented task hints are important and should be surfaced
- Gemini cost tracking will need estimated token accounting unless Google adds usage fields to embedding responses

Important PRD correction:

- the PRD currently says “Gemini Embedding 2 API” in `chatbot_widget_PRD.md`
- the current official stable Gemini embedding model is `gemini-embedding-001`

### Anthropic

Anthropic does not provide first-party embeddings.

Anthropic’s own embeddings guide explicitly recommends using an external embeddings vendor such as Voyage AI instead.

Implication for this library:

- `provider: 'anthropic'` should not be accepted for an embeddings API in the first release
- if the product later wants an Anthropic-adjacent embeddings story, the correct follow-up is an optional `voyage` adapter, not a fake Anthropic embeddings transport

## Recommended Product Decision

### Launch decision

Add embeddings to the unified library, but do not wait for a full multi-provider vector platform abstraction.

Recommended release scope:

1. Support `google` embeddings
2. Support `openai` embeddings
3. Reject `anthropic` embeddings with `ProviderCapabilityError`
4. Defer `voyage` to a later slice unless the chatbot widget requires it immediately

### Critical design rule

Embedding provider must be independent from completion provider.

The chatbot PRD already assumes a mixed-provider stack:

- Gemini embeddings
- Anthropic generation

That is the correct architecture. The unified library should preserve it rather than force one provider for both operations.

## Recommended Public API

The cleanest fit for this repo is a first-class `client.embed()` method, not an overload of `complete()` and not a fake conversation feature.

### Proposed request shape

```ts
export type EmbeddingProvider = 'google' | 'openai';

export type EmbeddingPurpose =
  | 'retrieval_document'
  | 'retrieval_query'
  | 'semantic_similarity'
  | 'classification'
  | 'clustering';

export interface EmbeddingRequestOptions {
  input: string | string[];
  model?: string;
  provider?: EmbeddingProvider;
  signal?: AbortSignal;

  // Useful across providers.
  dimensions?: number;
  purpose?: EmbeddingPurpose;

  providerOptions?: {
    google?: {
      title?: string;
    };
    openai?: {
      encodingFormat?: 'float' | 'base64';
      user?: string;
    };
  };
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
  usage: EmbeddingUsageMetrics;
}
```

### Why this shape fits the repo

- `LLMClient` already uses top-level verbs such as `complete()` and `stream()`
- embeddings are a first-class operation, not provider cache lifecycle metadata
- `input: string | string[]` matches the common denominator across OpenAI and Gemini
- `dimensions` is a valid cross-provider concept
- `purpose` is useful for retrieval systems and maps cleanly to Gemini while degrading safely on OpenAI

## Recommended Mapping Rules

### OpenAI mapping

Map canonical options to:

- `model`
- `input`
- `dimensions`
- `encoding_format` from `providerOptions.openai.encodingFormat`
- `user` from `providerOptions.openai.user`

OpenAI ignores `purpose`.

### Gemini mapping

Map canonical options to:

- `model: models/gemini-embedding-001`
- `content` or batched requests from `input`
- `outputDimensionality` from `dimensions`
- `taskType` from `purpose`
- `title` from `providerOptions.google.title`

Purpose mapping should be:

- `retrieval_query` -> `RETRIEVAL_QUERY`
- `retrieval_document` -> `RETRIEVAL_DOCUMENT`
- `semantic_similarity` -> `SEMANTIC_SIMILARITY`
- `classification` -> `CLASSIFICATION`
- `clustering` -> `CLUSTERING`

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

This is the most important implementation constraint.

You cannot safely:

- embed stored knowledge chunks with Gemini
- then embed the live user query with OpenAI
- and expect one `pgvector` index to return meaningful similarity scores

Embedding spaces are model-specific.

That means the PRD’s fallback language needs one of these two operational strategies:

1. Re-embed the corpus when the active embedding model changes
2. Store multiple embedding profiles side-by-side and query only the matching profile

The second option is safer for production migrations.

### 2. The library should not own chunking or vector storage

This repo should expose embedding generation, not become the knowledge-base pipeline itself.

Keep these concerns outside the unified client:

- PDF parsing
- URL crawling
- chunking strategy
- `pgvector` schema migration
- similarity search SQL

The library should only provide the provider-normalized embedding call that the widget backend uses.

### 3. Introduce an embedding profile in the widget app

For the chatbot platform, use an application-level profile concept such as:

```ts
interface EmbeddingProfile {
  dimensions?: number;
  id: string;
  model: string;
  provider: 'google' | 'openai';
}
```

Recommended behavior:

- each bot has one active embedding profile
- every stored vector records the profile id used to produce it
- runtime query embedding uses the same profile id
- profile swaps happen through a background reindex job, then an atomic cutover

### 4. Query/document purpose matters for Gemini

For the widget:

- use `retrieval_document` when embedding knowledge chunks
- use `retrieval_query` when embedding user messages for search

That distinction is important for retrieval quality on Gemini and should be represented in the library surface.

## Model Registry And Pricing Recommendations

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
}
```

Recommended new registry entries:

- `gemini-embedding-001`
- `text-embedding-3-small`
- `text-embedding-3-large`

### Why `kind` matters

Without a model-kind distinction:

- a caller could accidentally pass an embedding model into `complete()`
- or pass a generative model into `embed()`

That would fail late at the provider boundary instead of being rejected by the library.

## Usage And Cost Tracking Recommendations

### OpenAI

OpenAI embedding responses include usage counts, so:

- `inputTokens` can be provider-authoritative
- `costUSD` can be computed accurately from model pricing metadata

### Gemini

Gemini’s current embedding response docs describe returning the vector, but not request token usage.

Recommended v1 handling:

- expose `usage.inputTokens` only when authoritative provider usage exists
- for Gemini, either leave usage empty or mark it as estimated
- do not pretend Gemini embedding cost is exact unless the provider actually returns usage

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
3. Add OpenAI embedding adapter support in `src/providers/openai.ts`
4. Add Gemini embedding adapter support in `src/providers/gemini.ts`
5. Extend model metadata for embedding models in `src/models/prices.json`
6. Add cost handling for OpenAI embedding usage and estimated Gemini embedding usage
7. Add unit tests for request mapping, response mapping, model-kind validation, and client routing
8. Add live tests behind an opt-in gate for OpenAI and Gemini embeddings
9. Update docs with widget-oriented examples for ingest-time document embeddings and runtime query embeddings

## Recommended Tests

- OpenAI adapter test for single-string embeddings
- OpenAI adapter test for string-array embeddings
- OpenAI adapter test for `dimensions`
- Gemini adapter test for `purpose -> taskType`
- Gemini adapter test for `title`
- Gemini adapter test for `dimensions -> outputDimensionality`
- Client routing test for `client.embed()`
- Model registry test that embedding models cannot be used for `complete()`
- Live OpenAI embedding smoke test
- Live Gemini embedding smoke test

## Open Questions

- Should the first release expose only `client.embed()` or also provider-specific batch helpers for Gemini’s async embedding batches?
- Do we want a canonical `purpose` field, or should that remain provider-specific even though retrieval-query/document is central to the widget use case?
- Should Gemini embedding cost be estimated in-library or left undefined until provider usage is available?
- Is Voyage needed soon enough to justify a fourth provider surface for embeddings only?

## Bottom Line

Embeddings belong in this library, but as a separate first-class API from completions.

The correct near-term design is:

- `client.embed()`
- OpenAI + Gemini first
- Anthropic unsupported for embeddings
- embedding provider independent from generation provider
- widget app manages chunking, vector storage, and embedding-profile rollouts

That shape matches both the current provider landscape and the chatbot widget architecture already described in the PRD.

## Source Links

- OpenAI embeddings guide: https://platform.openai.com/docs/guides/embeddings
- OpenAI embeddings API reference: https://platform.openai.com/docs/api-reference/embeddings/create
- OpenAI `text-embedding-3-large` model page: https://platform.openai.com/docs/models/text-embedding-3-large
- Gemini embeddings guide: https://ai.google.dev/gemini-api/docs/embeddings
- Gemini embeddings API reference: https://ai.google.dev/api/embeddings
- Anthropic embeddings guide: https://docs.anthropic.com/en/docs/build-with-claude/embeddings
