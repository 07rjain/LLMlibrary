# Embeddings Review Cross-Check

Prepared: `2026-04-25`

This note cross-checks six follow-up suggestions from an external review against:

- the current `unified-llm-client` codebase
- the current public provider docs
- the widget-focused v1 scope already documented in this repo

## Summary

- `createInMemoryKnowledgeStore()` is now shipped.
- `unified-llm-client/chunking` is now shipped.
- Retrieval score-display normalization is now shipped through `scoreDisplay: 'raw' | 'relative_top_1'`.
- `createJsonFileKnowledgeStore()` is still a valid follow-up, but it remains unimplemented.
- Internal Gemini batching is still a valid optimization target, and current public docs do cover `gemini-embedding-2` multimodal inputs including PDF.
- `client.extractText()` is still product-useful, but it remains a poor fit for the core `LLMClient` surface.
- OpenAI embeddings remain a valid future provider addition, but not a missing v1 feature.

## 1. `InMemoryKnowledgeStore` / `JsonFileKnowledgeStore`

Verdict: `Partially addressed`

Why this concern is real:

- The original review correctly identified a real gap: the retrieval module used to ship only `PostgresKnowledgeStore`.
- That gap is now only partially open because the in-memory store has landed, but a file-backed local store still does not exist.

Current repo state:

- `src/retrieval.ts` now exports `createInMemoryKnowledgeStore()` alongside `KnowledgeStore`, `createDenseRetriever()`, `createHybridRetriever()`, `mergeRetrievalCandidates()`, `formatRetrievedContext()`, and `PostgresKnowledgeStore`.
- There is still no built-in JSON-file implementation today.

Recommended direction:

- Keep `createInMemoryKnowledgeStore()` as the lightweight built-in path.
- Add `createJsonFileKnowledgeStore()` next as a Node-only convenience layer.
- Keep both explicitly positioned as test/demo/single-process helpers, not as the production default.

Why I would not overreach:

- A JSON file store is not concurrency-safe, not multi-process-safe, and not a substitute for multitenant storage.
- The production recommendation should remain Postgres + `pgvector`.

## 2. `unified-llm-client/chunking`

Verdict: `Addressed`

Why this concern is real:

- The current library intentionally leaves chunking in the app layer.
- That is clean architecturally, but it does force every RAG consumer to rewrite the same text cleanup and splitting utilities.

Current repo state:

- The library now ships `unified-llm-client/chunking`.
- The current public helpers are `cleanText()`, `stripHtml()`, and `chunkText()`.
- The implementation is deterministic and dependency-light, which is the right first release shape.

Important limit:

- Do not put `extractTextFromUrl(url)` in the first version of this module.
- Fetching URLs introduces network policy, auth, robots, timeout, and SSR/runtime concerns that belong in the app ingestion layer, not in a pure chunking helper.

## 3. Internal batching for `client.embed()`

Verdict: `Valid, but narrower than the review suggests`

Why this concern is real:

- The current Gemini adapter still normalizes the input and then calls `:embedContent` once per item.
- For multi-chunk text ingestion, that means unnecessary round-trips.

Current repo state:

- `src/providers/gemini.ts` loops over normalized embedding requests and posts each one to `models/{model}:embedContent`.

What the provider docs support:

- Google documents both `models.embedContent` and `models.batchEmbedContents`.
- Google also documents multi-text embedding inputs.

Important limit:

- The current public Gemini embeddings docs explicitly document `gemini-embedding-2` multimodal inputs, including PDF.
- The safest optimization target is still text-only multi-input batching, because that is the clearest batch contract in the API reference.

Recommended direction:

- Optimize text-only multi-input requests first.
- Only use `batchEmbedContents` when all inputs are text, the model matches, and the effective embedding options match.
- Keep file/document-oriented inputs on the current single-item path until their batch semantics are explicitly verified and documented.

## 4. `client.extractText(...)`

Verdict: `Partially valid`

Why this suggestion is attractive:

- PDF-to-text and HTML-to-text extraction are real pain points in retrieval systems.
- A shared helper could reduce duplicated ingestion code across applications.

Why it is not a clean core-client feature:

- `LLMClient` is currently a provider transport layer for generation, conversations, model discovery, prompt caching, and embeddings.
- `extractText()` is a document parsing / OCR / transcription workflow, not a raw LLM transport primitive.
- A `filePath`-based API would also be Node-specific and would not fit the library's otherwise environment-agnostic request surface.

Recommended direction:

- If this is added, ship it as an optional module, not as a core `LLMClient` method.
- Prefer a canonical input shape over local file paths, for example document parts or byte inputs.
- Keep CLI-based fallbacks such as `pdftotext` and ingestion-worker orchestration in the app layer.

## 5. OpenAI embeddings

Verdict: `Valid roadmap item, not a v1 gap`

Why the suggestion is valid:

- OpenAI has a stable embeddings endpoint.
- It supports multiple text inputs in one request.
- It would be a straightforward future provider addition to the existing canonical embedding types.

Why it is not a current defect:

- The current repo scope is intentionally Google-only for embeddings in v1.
- `client.embed()` already rejects OpenAI and Anthropic clearly for that reason.
- The widget scope that drove v1 was not "support every embedding provider"; it was "ship one embeddings path that matches the current product direction."

Important product caveat:

- OpenAI's current embeddings docs are text-only.
- So OpenAI embeddings would be a text-oriented fallback provider, not a replacement for the current Google-first file/document path.

Recommended direction:

- Add OpenAI embeddings only when the product actually wants a second embedding provider for text ingestion or cost/quality tradeoffs.
- Until then, keep the current capability error behavior.

## 6. Score normalization in `formatRetrievedContext()`

Verdict: `Addressed`

Why this concern is real:

- Raw hybrid-fusion scores are not directly comparable to dense cosine scores.
- If scores are shown in logs or a UI, they can look less intuitive than normalized similarity values.

Current repo state:

- `formatRetrievedContext()` now supports `scoreDisplay: 'raw' | 'relative_top_1'`.
- Raw score output is explicitly labeled as `raw dense similarity`, `raw lexical relevance`, `raw fused rank score`, or `raw retrieval score`.
- Relative display scores are clearly labeled as display-only and not probabilities.

What remains important:

- Keep `RetrievalResult.score` unchanged.
- Treat `scoreDisplay` as formatting only, not ranking logic.
- Only surface relative scores in UI or logs when that presentation is actually useful.

## Recommended Follow-Up Order

My recommended order is slightly different from the external review:

1. Add `createInMemoryKnowledgeStore()`, then `createJsonFileKnowledgeStore()`.
2. Add `unified-llm-client/chunking` with pure local helpers only.
3. Add Gemini internal batching for text-only embedding arrays.
4. Add score-display normalization only if a UI or logs actually need it.
5. Add OpenAI embeddings only when the product wants a text-only second provider.
6. Add extraction helpers only as an optional module if the library intentionally wants to own OCR/parsing workflows.

## One Important Correction To Keep In Mind

The main thing to keep separate is embedding support versus batching support.

- Google now publicly documents `gemini-embedding-2` as multimodal and includes PDF examples.
- That does not automatically mean every multimodal path should be optimized through `batchEmbedContents` right away.
- The safest next step is still text-only batching, while keeping multimodal inputs on the current path until their batch semantics are validated separately.

That is the nuance that should drive prioritization.

## Sources

- Gemini embeddings guide: https://ai.google.dev/gemini-api/docs/embeddings
- Gemini embeddings API reference: https://ai.google.dev/api/embeddings
- OpenAI embeddings guide: https://developers.openai.com/api/docs/guides/embeddings
- OpenAI embeddings API reference: https://platform.openai.com/docs/api-reference/embeddings/create
