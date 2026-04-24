# Unified LLM Client Embeddings Integration Report

Date: April 23, 2026

Current project decision update: `2026-04-24`

- The active implementation scope is now Google Embedding 2 only for embeddings in v1.
- OpenAI embedding references below should be treated as deferred roadmap material, not the current delivery plan.
- Anthropic remains unsupported for embeddings.

## 1. Executive Summary

The chatbot widget PRD requires a knowledge-base path where users upload PDFs, URLs, and FAQs; the system indexes them; and the chatbot later retrieves only the most relevant chunks before answering. That requires embeddings, but the current `unified-llm-client` implementation is completion-focused and does not expose a first-class embedding API.

Recommendation:

- Add a first-class `client.embed()` API to `unified-llm-client`.
- Support `google` only with `gemini-embedding-2`, because the product PRD chooses Gemini Embedding 2 for multimodal/PDF knowledge ingestion.
- Defer `openai` embeddings in v1.
- Reject `anthropic` for embeddings unless a separate Voyage/Cohere-style provider is added later.
- Keep chunking, PDF page splitting, vector storage, BM25/reranking, citations, ingestion jobs, and tenant isolation in the chatbot application, not in the unified client library.

The unified client should generate vectors. It should not become the full RAG pipeline.

## 2. Why Embeddings Are Needed

We should not pass full PDFs, websites, or FAQ collections into the chat model on every message. That would clog context, increase latency/cost, and degrade answer quality as the corpus grows.

The correct flow is retrieval-augmented generation:

1. Ingest-time: turn each source into searchable units, embed those units, and store vectors with metadata.
2. Runtime: embed the visitor question using the same embedding model/profile.
3. Search: run `pgvector` similarity search with strict `tenant_id` and `bot_id` filters.
4. Answer: pass only the top relevant snippets/citations into the chat model.

This matches the PRD and research docs:

- `docs/Onboarding_flow.md` step 3 requires "Add knowledge" with ingestion progress and "ready to answer" status.
- `docs/Chatbot_widget_PRD.md` describes `pgvector` similarity search over `knowledge_chunks`.
- `docs/Chatbot_Widget_Research.md` chooses Google Gemini Embedding 2 and Postgres + pgvector for the knowledge layer.
- `CLAUDE.md` explicitly says the widget uses Gemini Embedding 2 vectors in pgvector for uploaded documents.

## 3. Current Unified Client State

Implementation repo from `CLAUDE.md`:

- GitHub: `https://github.com/07rjain/LLMlibrary`
- Local inspection path used for this report: `/tmp/LLMlibrary`
- Package name: `unified-llm-client`

Current capabilities:

- `LLMClient.complete()` and `LLMClient.stream()`
- Conversation/session APIs
- Tool calling
- Usage logging
- Model registry and pricing
- Provider adapters for Anthropic, OpenAI, and Gemini using raw `fetch`
- Edge-safe build, no provider SDK dependencies in core

Missing capabilities:

- No `client.embed()` method.
- No embedding request/response types in `src/types.ts`.
- OpenAI embeddings are intentionally out of scope for the first release.
- No Gemini embeddings transport in `src/providers/gemini.ts`.
- No embedding model metadata in `ModelInfo`.
- No model-kind validation to prevent calling `complete()` with an embedding model.
- No embedding usage/cost pathway.
- No mock embedding support for tests.
- No package/docs examples for embeddings.

Relevant current files:

- `src/types.ts` already has `DocumentPart`, `ImageBase64Part`, `ImageUrlPart`, and `AudioPart`. This is useful because Gemini Embedding 2 accepts multimodal content.
- `src/providers/gemini.ts` already translates `document`, `image_base64`, `image_url`, and `audio` parts into Gemini `inlineData` / `fileData`.
- `src/providers/openai.ts` currently only calls `/v1/responses`.
- `src/client.ts` dispatches completion and streaming only.
- `src/models/registry.ts` only validates completion-oriented capability flags.
- `src/usage.ts` stores completion-shaped usage events with `finish_reason`.
- `package.json` and `tsup.config.ts` export existing entries only; there is no embeddings entry.

Important correction:

`/tmp/LLMlibrary/docs/EMBEDDINGS_REPORT.md` already exists, but it is stale where it says Gemini's stable embedding model is `gemini-embedding-001` and treats Gemini as text-only. Current Google docs list `gemini-embedding-2` as GA, released April 22, 2026, with multimodal inputs including PDF.

## 4. Provider Reality Check

### Google Gemini Embedding 2

Google's current Gemini Embedding 2 model details state:

- Model ID: `gemini-embedding-2`
- Launch stage: GA
- Release date: April 22, 2026
- Inputs: text, images, audio, video, PDF
- Output: embeddings
- Default output size: 3072 dimensions
- Adjustable output dimensionality
- Maximum input tokens: 8,192
- PDF support: `application/pdf`
- PDF limit: 1 file per prompt, maximum 6 pages per file
- Supports document OCR
- Supports custom task instructions

Practical implication for the widget:

- We can embed PDF pages or small PDF page groups natively, without OCRing the full PDF ourselves first.
- We still need to split large PDFs, because the model has page and token limits.
- For best citations and progress reporting, the app should still extract/store text snippets or page labels alongside vectors.

### Gemini API vs Vertex AI

The current unified client Gemini adapter uses `GEMINI_API_KEY` and the Gemini API style endpoint. The user-provided docs are Vertex AI model docs. For our demo, the Gemini API key path worked with `gemini-embedding-2`.

Recommended scope:

- Phase 1: implement Gemini API key support through `https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent`.
- Phase 2: add optional Vertex AI support if the product needs Google Cloud project/region/OAuth controls.

Do not block the product MVP on Vertex AI auth unless enterprise controls are needed immediately.

### OpenAI Embeddings

OpenAI is deferred for embeddings in v1.

OpenAI supports text embeddings through `POST /v1/embeddings`.

Relevant behavior:

- Request accepts `input`, `model`, optional `dimensions`, optional `encoding_format`, and optional `user`.
- Response includes `data[].embedding`, `data[].index`, `model`, and token usage.
- `text-embedding-3-large` supports configurable dimensions and has a 3072-dimensional native size.

Practical implication:

- OpenAI remains useful as a reference point and future expansion option.
- It should not be used for native PDF/image/audio/video embeddings in this library.
- It is not part of the first embeddings release plan.

### Anthropic

Anthropic should not be exposed as an embeddings provider in v1. The library should throw `ProviderCapabilityError` for `provider: 'anthropic'` in `client.embed()`.

If a future Anthropic-adjacent embedding path is required, add a real provider such as Voyage AI. Do not fake Anthropic embeddings through Claude.

## 5. Recommended Public API

Add a first-class method:

```ts
const response = await client.embed({
  provider: 'google',
  model: 'gemini-embedding-2',
  input: 'What is your return policy?',
  dimensions: 3072,
  taskInstruction: 'Embed this customer question for question-answering retrieval.',
  tenantId: 'tenant_123',
  botId: 'bot_123',
});
```

Recommended core types:

```ts
export type EmbeddingProvider = Extract<
  CanonicalProvider,
  'google' | 'mock'
>;

export type EmbeddingPurpose =
  | 'retrieval_query'
  | 'retrieval_document'
  | 'semantic_similarity'
  | 'classification'
  | 'clustering'
  | 'question_answering'
  | 'code_retrieval';

export type EmbeddingInput =
  | string
  | EmbeddingContent
  | Array<string | EmbeddingContent>;

export interface EmbeddingContent {
  metadata?: Record<string, unknown>;
  parts: EmbeddingPart[];
  title?: string;
}

export type EmbeddingPart =
  | TextPart
  | ImageBase64Part
  | ImageUrlPart
  | DocumentPart
  | AudioPart
  | VideoPart;

export interface VideoPart {
  data?: string;
  mediaType: string;
  type: 'video';
  url?: string;
}

export interface EmbeddingRequestOptions {
  botId?: string;
  dimensions?: number;
  input: EmbeddingInput;
  model?: string;
  provider?: EmbeddingProvider;
  providerOptions?: EmbeddingProviderOptions;
  purpose?: EmbeddingPurpose;
  signal?: AbortSignal;
  taskInstruction?: string;
  tenantId?: string;
}

export interface EmbeddingProviderOptions {
  google?: GoogleEmbeddingOptions;
}

export interface GoogleEmbeddingOptions {
  taskInstruction?: string;
  taskType?: string; // legacy/compat option, not the primary Gemini 2 design
  title?: string;
}

export interface EmbeddingResultItem {
  dimensions: number;
  index: number;
  metadata?: Record<string, unknown>;
  values: number[];
}

export interface EmbeddingUsageMetrics {
  cost?: string;
  costUSD?: number;
  estimated?: boolean;
  inputTokens?: number;
  totalTokens?: number;
}

export interface EmbeddingResponse {
  embeddings: EmbeddingResultItem[];
  model: string;
  provider: EmbeddingProvider;
  raw: unknown;
  usage?: EmbeddingUsageMetrics;
}
```

Design notes:

- `input` must support single and batch inputs.
- For OpenAI, only string and string-array inputs should be accepted.
- For Gemini, multimodal `EmbeddingContent` should be accepted.
- `taskInstruction` should be first-class because Gemini Embedding 2 docs highlight task instructions.
- `purpose` should be canonical and provider-neutral. The adapter can map it to provider-specific behavior.
- Keep `GoogleEmbeddingOptions.taskType` only for backwards compatibility with older Gemini embedding APIs and current generic Gemini API docs. Do not force the whole public API around the older `taskType` enum.

## 6. Gemini Adapter Changes

File: `src/providers/gemini.ts`

Add:

- `GeminiEmbeddingOptions`
- `GeminiEmbeddingResponse`
- `GeminiEmbeddingUsageMetadata`
- `embed(options: GeminiEmbeddingOptions): Promise<EmbeddingResponse>`
- Request translation from `EmbeddingInput` to Gemini `Content`
- Response translation from Gemini `embedding.values` or `embeddings[]`
- Usage translation from `usageMetadata` when returned

Recommended endpoint:

```txt
POST /v1beta/models/{model}:embedContent
```

Request shape for a single item:

```json
{
  "content": {
    "parts": [
      { "text": "Embed this document for question-answering retrieval." },
      {
        "inlineData": {
          "mimeType": "application/pdf",
          "data": "<base64-pdf-page>"
        }
      }
    ]
  },
  "outputDimensionality": 3072
}
```

Adapter behavior:

- Reuse the existing Gemini `translateGeminiPart()` logic for `document`, `image_base64`, `image_url`, and `audio`.
- Add `VideoPart` support if we want full Gemini Embedding 2 modality coverage.
- If `taskInstruction` is present, prepend it as a text part.
- If `purpose` is present and no explicit `taskInstruction` is supplied, map it to a default instruction.
- Validate Gemini PDF limits at the app layer, not in the adapter, because the adapter cannot know page count from base64 safely.
- Allow `dimensions` to map to `outputDimensionality`.
- Normalize `models/gemini-embedding-2` and `gemini-embedding-2` consistently, matching existing Gemini model naming behavior.
- For batch inputs, start with sequential `embedContent` calls for correctness. Add `batchEmbedContents` later as an optimization.

Suggested default task instructions:

```ts
const googleTaskInstructions = {
  retrieval_query:
    'Embed this user question for question-answering retrieval.',
  retrieval_document:
    'Embed this knowledge-base document for question-answering retrieval.',
  semantic_similarity:
    'Embed this content for semantic similarity comparison.',
  classification:
    'Embed this content for classification.',
  clustering:
    'Embed this content for clustering.',
  question_answering:
    'Embed this content for question answering.',
  code_retrieval:
    'Embed this content for code retrieval.',
} satisfies Record<EmbeddingPurpose, string>;
```

## 7. OpenAI Adapter Changes

File: `src/providers/openai.ts`

Add:

- `OpenAIEmbeddingOptions`
- `OpenAIEmbeddingResponsePayload`
- `embed(options: OpenAIEmbeddingOptions): Promise<EmbeddingResponse>`
- Request translation to `/v1/embeddings`
- Response translation from `data[].embedding`
- Usage translation from `usage.prompt_tokens` and `usage.total_tokens`

Request shape:

```json
{
  "model": "text-embedding-3-large",
  "input": ["What is your return policy?"],
  "dimensions": 3072,
  "encoding_format": "float"
}
```

Adapter behavior:

- Accept string or string-array only.
- Reject `DocumentPart`, image, audio, and video with `ProviderCapabilityError`.
- Map `dimensions` to OpenAI `dimensions`.
- Map `providerOptions.openai.encodingFormat` to `encoding_format`.
- Map OpenAI `usage.prompt_tokens` to `inputTokens`.
- Map OpenAI `usage.total_tokens` to `totalTokens`.

## 8. Client Changes

File: `src/client.ts`

Add constructor options:

```ts
export interface LLMClientOptions {
  defaultEmbeddingModel?: string;
  defaultEmbeddingProvider?: EmbeddingProvider;
}
```

Add public method:

```ts
async embed(options: EmbeddingRequestOptions): Promise<EmbeddingResponse>
```

Add private methods:

- `resolveEmbeddingRequest()`
- `dispatchEmbed()`
- `logEmbeddingUsageEvent()` if usage logging is extended

Resolution rules:

1. Use `options.model` if provided.
2. Else use `defaultEmbeddingModel`.
3. Else use provider default:
   - Google: `gemini-embedding-2`
   - OpenAI: `text-embedding-3-large` or `text-embedding-3-small`, depending on product cost preference
4. Resolve provider from explicit `options.provider`, model registry metadata, or `defaultEmbeddingProvider`.
5. Reject unknown provider/model combinations.
6. Reject completion models in `embed()`.
7. Reject embedding models in `complete()` and `stream()`.

The embedding provider must be independent from the chat provider. The chatbot can use Claude for generation and Gemini for embeddings in the same request lifecycle.

## 9. Model Registry Changes

Files:

- `src/types.ts`
- `src/models/registry.ts`
- `src/models/prices.json`
- `src/models/prices.ts`

Extend `ModelInfo`:

```ts
export interface ModelInfo {
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  contextWindow: number;
  embeddingDimensions?: {
    default: number;
    max: number;
    min?: number;
    recommended?: number[];
  };
  id: string;
  inputPrice: number;
  kind?: 'completion' | 'embedding';
  lastUpdated: string;
  maxPdfPages?: number;
  outputPrice: number;
  provider: CanonicalProvider;
  supportedInputModalities?: Array<
    'text' | 'image' | 'document' | 'audio' | 'video'
  >;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
}
```

Compatibility rule:

- Existing models can omit `kind`, and the registry treats missing `kind` as `'completion'`.

Add registry helpers:

```ts
assertModelKind(modelId: string, kind: 'completion' | 'embedding'): ModelInfo
```

Add model entries:

```json
{
  "gemini-embedding-2": {
    "provider": "google",
    "kind": "embedding",
    "contextWindow": 8192,
    "inputPrice": 0,
    "outputPrice": 0,
    "supportsStreaming": false,
    "supportsTools": false,
    "supportsVision": false,
    "embeddingDimensions": {
      "default": 3072,
      "max": 3072,
      "recommended": [3072, 1536, 768]
    },
    "supportedInputModalities": ["text", "image", "document", "audio", "video"],
    "maxPdfPages": 6,
    "lastUpdated": "2026-04-22"
  }
}
```

Also add:

- `text-embedding-3-small`
- `text-embedding-3-large`

Do not invent pricing. Before implementation, update `inputPrice` from official provider pricing pages and make `pnpm pricecheck` pass. If pricing is not final or usage metadata is incomplete, return `usage.estimated = true` or leave cost undefined for that provider.

## 10. Usage Logging Changes

Current `UsageEvent` assumes completion-style requests with `finishReason`, input tokens, output tokens, and cached tokens.

Recommended change:

```ts
export type UsageOperation = 'completion' | 'embedding';

export interface UsageEvent extends UsageMetrics {
  operation?: UsageOperation;
  embeddingDimensions?: number;
  finishReason?: CanonicalFinishReason;
}
```

Postgres schema changes:

- Add `operation TEXT NOT NULL DEFAULT 'completion'`
- Add `embedding_dimensions INTEGER`
- Make `finish_reason` nullable or default it to `''`
- Add index `(tenant_id, operation, timestamp DESC)`

Compatibility:

- Existing completion events should behave the same.
- Embedding events should not fake `finishReason: 'stop'` just to fit the old schema.
- If schema migration is too much for the first patch, return embedding usage in `EmbeddingResponse` and skip persistent logging until the schema is updated.

## 11. Package Exports And Build Changes

Files:

- `src/index.ts`
- `src/client.ts`
- `src/types.ts`
- `package.json`
- `tsup.config.ts`

Minimum:

- Export embedding types from the main package surface.
- Export `client.embed()` through the existing `unified-llm-client` and `unified-llm-client/client` entries.

Optional:

- Add `src/embeddings.ts` and package export `unified-llm-client/embeddings` if embedding helpers become large.

Recommended first patch:

- Keep types in `src/types.ts`.
- Keep method on `LLMClient`.
- Avoid a new entry point unless needed.

This keeps the API small and avoids unnecessary package export churn.

## 12. Test Plan

Unit tests:

- `test/client.test.ts`: `client.embed()` resolves model/provider correctly.
- `test/client.test.ts`: `client.embed()` uses `defaultEmbeddingModel`.
- `test/client.test.ts`: `complete()` rejects embedding models.
- `test/client.test.ts`: `embed()` rejects completion models.
- `test/client.test.ts`: Anthropic embedding requests throw `ProviderCapabilityError`.
- `test/gemini.adapter.test.ts`: text embedding request maps to `embedContent`.
- `test/gemini.adapter.test.ts`: `dimensions` maps to `outputDimensionality`.
- `test/gemini.adapter.test.ts`: PDF `DocumentPart` maps to `inlineData` with `application/pdf`.
- `test/gemini.adapter.test.ts`: `taskInstruction` is prepended as a text part.
- `test/gemini.adapter.test.ts`: response `embedding.values` maps to `EmbeddingResponse.embeddings[0].values`.
- `test/openai.adapter.test.ts`: string input maps to `/v1/embeddings`.
- `test/openai.adapter.test.ts`: string array maps to a batch request.
- `test/openai.adapter.test.ts`: multimodal input throws provider capability error.
- `test/model-registry.test.ts`: `kind` defaults to completion.
- `test/model-registry.test.ts`: embedding metadata is returned correctly.
- `test/usage.test.ts`: embedding operation is logged/aggregated if usage schema is extended.

Mock client tests:

- Add `embeddings?: Array<EmbeddingResponse | ((options) => EmbeddingResponse | Promise<EmbeddingResponse>)>` to `MockLLMClientOptions`.
- Default mock embedding can return a deterministic small vector.

Live tests:

- Gated behind `LIVE_TESTS=1`.
- Google text embedding smoke test using `GEMINI_API_KEY`.
- Google PDF embedding smoke test with a tiny one-page PDF fixture.
- OpenAI text embedding smoke test using `OPENAI_API_KEY`.
- Assert dimensions match requested dimensions.

Quality gates:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm edgecheck`
- `pnpm sizecheck`
- `pnpm pricecheck`

## 13. Widget App Integration

The unified client should not own ingestion. The widget app should own source management, vector storage, retrieval policy, progress, and citations.

Recommended app tables:

```sql
embedding_profiles (
  id uuid primary key,
  tenant_id uuid not null,
  bot_id uuid not null,
  provider text not null,
  model text not null,
  dimensions int not null,
  purpose text not null,
  task_instruction text,
  created_at timestamptz not null default now()
);

knowledge_sources (
  id uuid primary key,
  tenant_id uuid not null,
  bot_id uuid not null,
  type text not null,
  name text not null,
  status text not null,
  progress_percent int not null default 0,
  error_message text,
  embedding_profile_id uuid references embedding_profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

knowledge_chunks (
  id uuid primary key,
  tenant_id uuid not null,
  bot_id uuid not null,
  source_id uuid not null references knowledge_sources(id),
  embedding_profile_id uuid not null references embedding_profiles(id),
  content text not null,
  citation jsonb not null,
  metadata jsonb not null default '{}',
  embedding vector(3072) not null,
  created_at timestamptz not null default now()
);
```

Every query must include:

```sql
where tenant_id = $1
  and bot_id = $2
  and embedding_profile_id = $3
```

Do not search across tenants, bots, or embedding profiles.

## 14. Onboarding Flow Impact

Current onboarding step:

> Add knowledge. User uploads PDFs or adds URLs/FAQs; the system indexes them and shows ingestion progress plus "ready to answer" status.

Recommended implementation:

1. User uploads PDF or adds URL/FAQ.
2. App creates a `knowledge_sources` row with `status = 'queued'`.
3. Background job starts and sets `status = 'processing'`.
4. For PDFs:
   - Split large PDFs into page or <=6-page units for Gemini Embedding 2.
   - Send the page PDF/document part to `client.embed()`.
   - Extract or store display text/snippet for citations.
5. For URLs:
   - Fetch readable content with the app ingestion service.
   - Chunk text.
   - Call `client.embed()` for each chunk.
6. For FAQs:
   - Treat each Q/A pair as one or more text chunks.
   - Call `client.embed()`.
7. Store vectors in `knowledge_chunks`.
8. Update progress after each successful chunk/page.
9. Mark source `ready` when all chunks are stored.
10. Preview chat uses `search_knowledge_base` to retrieve chunks and show citations.

Status model:

- `queued`
- `processing`
- `ready`
- `failed`
- `needs_reindex`

User-facing statuses:

- "Waiting to index"
- "Indexing page 3 of 18"
- "Ready to answer"
- "Failed: unsupported PDF or API error"
- "Needs re-indexing: embedding settings changed"

## 15. Implementation Task Breakdown

### Epic 1: Public Embedding Types

Tasks:

- Add `EmbeddingProvider`, `EmbeddingPurpose`, `EmbeddingInput`, `EmbeddingContent`, `EmbeddingPart`, `VideoPart`.
- Add `EmbeddingRequestOptions`, `EmbeddingResponse`, `EmbeddingResultItem`, `EmbeddingUsageMetrics`.
- Add provider-specific embedding option types.
- Export all types from the package root.

Acceptance criteria:

- TypeScript users can import embedding types from `unified-llm-client`.
- Existing completion type exports remain unchanged.
- No runtime dependency is added.

### Epic 2: Model Registry Support

Tasks:

- Add optional `kind` to `ModelInfo`.
- Add embedding metadata fields.
- Add `assertModelKind()`.
- Default missing `kind` to `completion`.
- Add Gemini and OpenAI embedding models to prices/registry.
- Update pricing freshness checks if they assume all models have output pricing.

Acceptance criteria:

- Completion models still work without edits by consumers.
- `complete()` rejects embedding models.
- `embed()` rejects completion models.
- Registry lists embedding metadata.

### Epic 3: Gemini Embedding Adapter

Tasks:

- Add `GeminiAdapter.embed()`.
- Add request translator for string and multimodal `EmbeddingContent`.
- Reuse Gemini part translation for document/image/audio.
- Add `VideoPart` translation.
- Support `dimensions` as `outputDimensionality`.
- Support `taskInstruction`.
- Parse `embedding.values`.
- Parse `usageMetadata` when present.
- Map Gemini errors through existing error handling.

Acceptance criteria:

- Text embedding works.
- PDF page embedding works.
- Requested dimensions are respected.
- No SDK dependency is introduced.
- Existing Gemini completion and cache tests still pass.

### Epic 4: OpenAI Embedding Adapter

Tasks:

- Add `OpenAIAdapter.embed()`.
- Add request translator for text and text batches.
- Add `/v1/embeddings` transport.
- Parse `data[].embedding`.
- Parse `usage`.
- Reject multimodal inputs.

Acceptance criteria:

- Single text embedding works.
- Batch text embedding works.
- Dimensions are passed through.
- Usage metrics are returned.
- Existing OpenAI completion tests still pass.

### Epic 5: LLMClient Dispatch

Tasks:

- Add `defaultEmbeddingModel` and `defaultEmbeddingProvider`.
- Add `client.embed()`.
- Add embedding request resolution.
- Add embedding dispatch switch.
- Add authentication errors for missing provider keys.
- Add mock embedding queue.

Acceptance criteria:

- `LLMClient.fromEnv({ defaultEmbeddingModel: 'gemini-embedding-2' }).embed(...)` works with `GEMINI_API_KEY`.
- Generation and embedding providers can differ.
- Mock client supports deterministic embeddings in app tests.

### Epic 6: Usage And Cost

Tasks:

- Decide whether to persist embedding usage in v1 or return it only in response.
- If persistent, add `operation` and `embedding_dimensions` to usage events/schema.
- Parse OpenAI embedding token usage.
- Parse Gemini `usageMetadata` when returned.
- Leave cost undefined or estimated where pricing/usage is not exact.

Acceptance criteria:

- Usage logging does not break existing completion analytics.
- Embedding usage is not falsely represented as completion usage.
- Costs are marked estimated when they are estimated.

### Epic 7: Docs And Examples

Tasks:

- Update README with text embedding example.
- Add Gemini PDF embedding example.
- Add widget RAG example showing ingest-time and runtime query embedding.
- Update API docs / TypeDoc.
- Update stale upstream `docs/EMBEDDINGS_REPORT.md`.

Acceptance criteria:

- A developer can copy a minimal `client.embed()` example.
- Docs clearly state that vector storage and chunking are app responsibilities.
- Docs warn that query and corpus must use the same embedding profile.

### Epic 8: Widget App Integration

Tasks:

- Replace raw Gemini demo calls with `unified-llm-client` once embedding support lands.
- Create `embedding_profiles`.
- Store source status/progress.
- Store vectors in pgvector.
- Ensure every retrieval query filters by tenant, bot, and embedding profile.
- Add citations from source/page/chunk metadata.
- Add re-index flow when model/dimensions/task instruction changes.

Acceptance criteria:

- User can upload a PDF and see ingestion progress.
- User sees "ready to answer" only after vectors are stored.
- Preview chat retrieves from the uploaded document.
- Citations point to the source/page/FAQ.
- Cross-tenant retrieval leakage is impossible by query filters and RLS.

## 16. Risks And Decisions

### Risk: Native PDF Embedding Does Not Remove Ingestion Design

Gemini Embedding 2 can embed PDFs natively, but the product still needs page splitting, source tracking, citations, progress, retries, and vector storage. Native PDF support improves input quality; it does not replace RAG infrastructure.

### Risk: Embedding Model Changes Break Search

Vectors from different models or dimensions should not be mixed in one index. The app must store an `embedding_profile_id` and only search matching profiles.

### Risk: Vertex AI Requirements May Appear Later

The current library is API-key based for Gemini. If enterprise Google Cloud controls are required, add a Vertex-specific auth/base URL mode later.

### Risk: Provider APIs Are Not Symmetric

Gemini supports multimodal embedding. OpenAI embeddings are text-oriented. The unified API should normalize common behavior but still throw capability errors when a provider cannot support an input.

## 17. Recommended First PR Scope

Keep the first PR focused:

- `client.embed()`
- Google `gemini-embedding-2`
- OpenAI `/v1/embeddings`
- Embedding model registry metadata
- Basic usage metrics in response
- Unit tests and live smoke tests
- Docs examples

Defer:

- Full Vertex AI OAuth/project/region support
- Async/batch embedding jobs inside the library
- Vector DB abstractions
- Chunking abstractions
- Reranking
- Citation assembly
- UI ingestion progress

Those deferred items belong in the chatbot app or later optimization work.

## 18. Sources

- Project repo from `CLAUDE.md`: https://github.com/07rjain/LLMlibrary
- Google Gemini Embedding 2 model docs: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2
- Google Gemini API embeddings reference: https://ai.google.dev/api/embeddings
- OpenAI embeddings guide: https://developers.openai.com/api/docs/guides/embeddings#obtaining-the-embeddings
- OpenAI embeddings API reference: https://platform.openai.com/docs/api-reference/embeddings/create
