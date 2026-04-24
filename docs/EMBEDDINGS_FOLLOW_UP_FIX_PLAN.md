# Embeddings Follow-Up Fix Plan

Prepared: `2026-04-25`

This report turns the external embeddings review into a concrete implementation plan for `unified-llm-client`.

It answers two questions:

1. Which follow-up suggestions are actually valid against the current codebase and current provider docs?
2. If we do them, what is the safest way to ship them without regressing the current embeddings and retrieval surface?

For the shorter verdict-only version, see [EMBEDDINGS_REVIEW_CROSSCHECK.md](./EMBEDDINGS_REVIEW_CROSSCHECK.md).  
For the current v1 embeddings scope, see [EMBEDDINGS_REPORT.md](./EMBEDDINGS_REPORT.md).

## Executive Summary

The external review is directionally useful, but the suggestions are not all the same kind of work.

There are three categories:

- `Ship next`: Gemini text batching
- `Shipped`: lightweight stores, chunking helpers, and score-display normalization
- `Do only if product scope changes`: OpenAI embeddings and extraction helpers

The highest-value fixes are still the simplest ones:

1. optimize Gemini multi-text embedding arrays through `batchEmbedContents`
2. reevaluate OpenAI embeddings only if product scope expands
3. keep extraction helpers optional

Those three changes reduce the most downstream boilerplate without changing the current public generation flow.

## Important Correction To Earlier Notes

One point needs to be corrected explicitly.

Current public Gemini embeddings docs do document `gemini-embedding-2` as multimodal and include a PDF example. So the broader Google embedding surface is not purely project-local inference anymore.

What is still true:

- the `batchEmbedContents` API reference is written around batches of strings / `EmbedContentRequest` objects
- the safest optimization target is still text-only multi-input batching
- file and PDF embedding should stay on the existing single-request path unless batch semantics for those modalities are validated separately

That is the right nuance. The fix plan below follows it.

## Current Repo State

The library already ships:

- `client.embed()` for Google Embedding 2
- `createInMemoryKnowledgeStore()` for local demos, tests, and single-process apps
- `unified-llm-client/chunking` for reusable text cleanup and chunk splitting
- `PostgresKnowledgeStore`
- `createDenseRetriever()`
- `createHybridRetriever()`
- `mergeRetrievalCandidates()`
- `formatRetrievedContext()`
- rerank hook support
- active embedding profile helpers and reindex helpers

The library does not currently ship:

- `InMemoryKnowledgeStore`
- `JsonFileKnowledgeStore`
- score-display normalization in `formatRetrievedContext()`
- internal Gemini text batching for embedding arrays
- extraction helpers
- OpenAI embeddings

That means the current embeddings implementation is complete for the v1 product scope, but it still leaves some high-value convenience gaps.

## Recommendation Matrix

| Item | Verdict | Priority | Why |
| --- | --- | --- | --- |
| `InMemoryKnowledgeStore` | Shipped | `P1` | Helps demos, tests, local apps immediately |
| `JsonFileKnowledgeStore` | Ship | `P1` | Removes common single-tenant boilerplate |
| `unified-llm-client/chunking` | Shipped | `P1` | Every RAG app rewrites this today |
| Gemini text batching | Ship | `P1` | Real latency and request-count win |
| Score normalization | Shipped | `P3` | Clearer logs/UI without implying probabilities |
| OpenAI embeddings | Defer | `P2` | Useful later, not needed for current product scope |
| Extraction helpers | Defer | `P2` | Useful, but belongs outside the core client |

## Fix 1: Add Lightweight Knowledge Stores

### Why this is worth doing

The retrieval module currently has a production-grade Postgres path, but no low-friction local path.

That leaves three avoidable problems:

- examples need custom storage code
- tests need custom fake stores
- simple deployments pay a Postgres complexity tax too early

### What to ship

Public API:

```ts
import {
  createInMemoryKnowledgeStore,
  createJsonFileKnowledgeStore,
} from 'unified-llm-client/retrieval';
```

Recommended first surface:

- `createInMemoryKnowledgeStore()`
- `createJsonFileKnowledgeStore(path, options?)`

### Proposed behavior

Both stores should support the existing read path:

- `searchByEmbedding()`
- optional `searchByText()`

They should also expose write helpers directly on the concrete store, even if those helpers are not part of the base `KnowledgeStore` interface:

- `upsertSource()`
- `upsertChunks()`
- `deleteSource()`
- `clear()`

### Why not expand `KnowledgeStore` itself

The current `Retriever` only needs read behavior. Keeping `KnowledgeStore` search-focused avoids forcing every implementation to pretend it owns ingestion workflows.

That is already how `PostgresKnowledgeStore` behaves in practice: it implements the search interface and also exposes extra ingestion-oriented helpers.

### Suggested implementation shape

Internal file layout:

- `src/retrieval/in-memory-store.ts`
- `src/retrieval/json-file-store.ts`
- re-export through `src/retrieval.ts`

### Risks

- JSON file storage is not concurrency-safe
- JSON file storage is not good for multi-process writers
- cosine search on flat arrays is fine for small data, but not for large corpora

So the docs must be explicit:

- use these stores for demos, tests, and simple local apps
- use `PostgresKnowledgeStore` for production

### Tests

Add:

- deterministic dense search tests
- lexical search tests
- source deletion tests
- JSON persistence round-trip tests
- JSON reload tests

## Fix 2: Add `unified-llm-client/chunking`

### Why this is worth doing

Chunking is still the most duplicated part of every RAG app built on top of this library.

The current design decision to keep chunking out of `LLMClient` is still correct. But that does not mean the repo should force every consumer to rebuild the same utilities.

### What to ship

Public API:

```ts
import {
  cleanText,
  stripHtml,
  chunkText,
} from 'unified-llm-client/chunking';
```

Recommended v1 surface:

- `cleanText(input: string): string`
- `stripHtml(input: string): string`
- `chunkText(input: string, options?): TextChunk[]`

Recommended chunk output:

```ts
interface TextChunk {
  endOffset: number;
  index: number;
  startOffset: number;
  text: string;
}
```

### What not to ship yet

Do not ship `extractTextFromUrl(url)` in the first chunking release.

Reasons:

- it introduces network behavior into a utility module
- it raises SSR/runtime questions
- it couples the library to fetch-and-clean policies that belong in the ingestion app

### Suggested packaging

Add:

- `src/chunking.ts`
- `./chunking` export in `package.json`
- `chunking` entry in `tsup.config.ts`

This keeps it symmetrical with `./retrieval`.

### Tests

Add:

- whitespace normalization tests
- HTML stripping tests
- overlap boundary tests
- long-text chunk count and offset tests
- regression tests for empty/small input

## Fix 3: Optimize Gemini Embedding Arrays With `batchEmbedContents`

### Why this is worth doing

The current Gemini adapter loops over normalized inputs and calls `:embedContent` once per item. That is correct, but it is inefficient for a common case: an array of text chunks.

### What the docs support

Current Google docs explicitly document:

- `gemini-embedding-2` multimodal embeddings, including PDF
- `batchEmbedContents`
- `embedContent` aggregation behavior for multiple inputs on Embeddings 2

That last point matters. For `gemini-embedding-2`, sending multiple inputs through `embedContent` can aggregate them into one embedding, which is not what `client.embed({ input: [...] })` should do when the caller expects one vector per input item.

### Safe optimization rule

Use `batchEmbedContents` only when all of the following are true:

- the normalized request contains more than one item
- every item is text-only
- every item resolves to the same model
- every item resolves to the same effective embedding options
- no file/document/image/audio/video inputs are involved

Otherwise:

- keep the current per-item `embedContent` loop

### Concrete code change

Primary file:

- `src/providers/gemini.ts`

Implementation sketch:

1. Normalize the input as today.
2. Detect the batch-safe text-only case.
3. Build a `batchEmbedContents` request for those items.
4. Map the batch response back into canonical `EmbeddingResponse.embeddings`.
5. Sum or map token usage conservatively if usage metadata is returned.
6. Preserve the existing single-item / multimodal path untouched.

### Why not batch everything

Because the library should optimize only where semantics are clear.

The text-array case is clear.
The multimodal batch case is not clear enough yet to risk semantic drift.

### Tests

Add:

- unit test: text array uses `batchEmbedContents`
- unit test: mixed or document input stays on `embedContent`
- unit test: single text input stays on `embedContent`
- unit test: usage metadata still maps correctly
- live smoke test: multiple text chunks return multiple vectors

## Fix 4: Score-Display Normalization

### Why this is low priority

This is not a retrieval-quality fix. It is a display-quality fix.

The current problem is that hybrid fusion scores can look odd beside dense cosine scores in logs or UI output.

### What to ship if needed

Prefer a display-oriented option over mutating the meaning of `score`:

```ts
formatRetrievedContext(results, {
  includeScores: true,
  scoreDisplay: 'raw' | 'relative_top_1',
});
```

I would avoid a vague `normalizeScores: true` flag. A named display mode is easier to interpret later.

### Concrete code change

Primary file:

- `src/retrieval.ts`

Change:

- extend `FormatRetrievedContextOptions`
- compute display scores only when formatting output text
- do not rewrite `RetrievalResult.score`

### Tests

Add:

- formatting test for raw scores
- formatting test for relative display scores
- regression test that retrieval ranking order stays unchanged

## Fix 5: OpenAI Embeddings

### Why this is not a current bug

The library intentionally shipped Google-only embeddings for v1.

So OpenAI embeddings are not missing from the current scope. They are simply deferred.

### When to do this

Do it only if the product wants one of these:

- a second embedding provider for text-only ingestion
- cost/performance tradeoffs across providers
- text-only embeddings in environments where Google is not desired

### Concrete code change

Primary files:

- `src/types.ts`
- `src/client.ts`
- `src/providers/openai.ts`
- `src/models/prices.json`
- `src/models/registry.ts`

Required changes:

- add `'openai'` back into the supported embedding provider surface
- implement `/v1/embeddings`
- support `dimensions`
- map multiple text inputs
- reject non-text inputs clearly
- add usage/cost mapping

### Product caveat

OpenAI embeddings remain text-only in the current public docs. So this should be documented as a text-provider expansion, not as a replacement for the Google-first document path.

### Tests

Add:

- client tests for provider resolution
- adapter tests for single and multi-text input
- capability tests rejecting document/image/audio inputs
- live smoke test with text input only

## Fix 6: Extraction Helpers

### Why this should not go into `LLMClient`

The external review is right that PDF extraction and fallback logic are annoying. But adding `client.extractText()` to the core client would blur the boundary between provider transport and document-ingestion workflows.

That would make `LLMClient` responsible for:

- parsing
- OCR-like transcription prompts
- file workflow choices
- environment-specific fallback behavior

That is too much for the current core client abstraction.

### Better shape

If the repo wants to own this area, ship it as an optional module:

```ts
import { extractTextFromDocument } from 'unified-llm-client/extraction';
```

Possible future surface:

- `extractTextFromDocument()`
- `extractPdfToMarkdown()`
- `extractHtmlToText()`

### Recommendation

Do not start here.

Only do this after the store, chunking, and batching work is shipped and only if the product still feels extraction pain in multiple consumers.

## Recommended Delivery Order

### Phase 1

- `createInMemoryKnowledgeStore()`
- `createJsonFileKnowledgeStore()`
- `unified-llm-client/chunking`

Why first:

- highest boilerplate reduction
- no provider-risk
- immediately useful for demos, docs, tests, and starter apps

### Phase 2

- Gemini text batching

Why second:

- meaningful performance improvement
- moderate provider-specific risk
- isolated to one adapter

### Phase 3

- score-display normalization

Why third:

- tiny and safe
- only useful if users actually surface scores

### Phase 4

- OpenAI embeddings or extraction helpers, depending on product demand

Why last:

- both expand surface area materially
- neither is required to improve the current Google-first embeddings path

## Concrete Fix Plan

If we want to execute this backlog cleanly, the best sequence is:

1. Add lightweight stores under `unified-llm-client/retrieval`
2. Add `unified-llm-client/chunking`
3. Add Gemini text batching
4. Update examples and docs to use the new helpers
5. Reassess whether extraction helpers or OpenAI embeddings are still needed

## Sources

- Gemini embeddings guide: https://ai.google.dev/gemini-api/docs/embeddings
- Gemini embeddings API reference: https://ai.google.dev/api/embeddings
- OpenAI embeddings guide: https://developers.openai.com/api/docs/guides/embeddings
- OpenAI embeddings API reference: https://platform.openai.com/docs/api-reference/embeddings/create
