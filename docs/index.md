---
layout: home

hero:
  name: Unified LLM Client
  text: One TypeScript client for OpenAI, Anthropic, and Gemini
  tagline: Provider-agnostic completions, streaming, conversations, tools, persistence, routing, and usage tracking for real applications.
  actions:
    - theme: brand
      text: Get Started
      link: /GETTING_STARTED
    - theme: alt
      text: Read The Guides
      link: /README
    - theme: alt
      text: API Reference
      link: /api/

features:
  - title: One client surface
    details: Use the same request and response model across providers instead of rewriting app code for each SDK.
  - title: Built for product workflows
    details: Ship one-shot completions, streaming UIs, tool calls, conversation state, and session persistence from the same library.
  - title: Responses-first OpenAI transport
    details: OpenAI requests already use the stateless Responses API while library-owned history and session storage stay provider-agnostic.
  - title: Production-oriented primitives
    details: Add budgets, routing, usage logging, Postgres storage, Redis storage, and a framework-agnostic Session API when the app grows up.
---

## Start Here

Install from GitHub:

```bash
pnpm add github:07rjain/LLMlibrary
```

Then create a client:

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});
```

The fastest path through the docs is:

1. [Getting Started](./GETTING_STARTED.md)
2. [Completions And Streaming](./COMPLETIONS_AND_STREAMING.md)
3. [Conversations And Tools](./CONVERSATIONS_AND_TOOLS.md)
4. [Persistence And Session API](./PERSISTENCE_AND_SESSION_API.md)
5. [Production Setup](./PRODUCTION_SETUP.md)
6. [Production Guide](./PRODUCTION_GUIDE.md)

If you want the lower-level generated API surface, open [API Reference](./api/index.html).

If you want a concrete production deployment checklist for `.env`, explicit Postgres wiring, and where embeddings are persisted, read [Production Setup](./PRODUCTION_SETUP.md).

If you need the providers' current live catalogs, use `client.models.listRemote({ provider })` and treat the result as discovery data. It does not automatically replace the checked-in model registry.

Embeddings now ship in the library through `client.embed()` with the Google Embedding 2 path. Optional retrieval primitives are available from the package root and from `unified-llm-client/retrieval`, including `InMemoryKnowledgeStore` for local demos and tests, `PostgresKnowledgeStore` for app-owned `pgvector` retrieval, rerank hook support in the retrievers, and active-profile / reindex helpers for rollout-safe storage. Reusable text-prep helpers now ship from `unified-llm-client/chunking`, and retrieval score display can be formatted in a clearer, non-probabilistic way. Keep query embeddings and stored chunk embeddings on the same embedding profile; the library does not mix profiles for you.

For embeddings planning tied to the chatbot widget use case, see [Embeddings Integration Report](./EMBEDDINGS_REPORT.md).
For a cross-check of the recent follow-up review and the recommended post-v1 order, see [Embeddings Review Cross-Check](./EMBEDDINGS_REVIEW_CROSSCHECK.md).
For the detailed implementation plan covering lightweight stores, chunking helpers, Gemini batching, OpenAI embeddings, and extraction helpers, see [Embeddings Follow-Up Fix Plan](./EMBEDDINGS_FOLLOW_UP_FIX_PLAN.md).
For the broader retrieval architecture, storage model, and rollout strategy, see [Embeddings And Retrieval Architecture Report](./EMBEDDINGS_RETRIEVAL_ARCHITECTURE_REPORT.md).
For the concrete multitenant retrieval API, safety, and scaling plan, see [Retrieval API Integration Report](./RETRIEVAL_API_INTEGRATION_REPORT.md).
Embeddings implementation work is tracked in the repository root as `embeddings_todo.md`.
For provider-specific implementation planning, see [Prompt Caching Report](./PROMPT_CACHING_REPORT.md).
Prompt caching work is tracked in the repository root as `prompt_caching_todo.md`.
For the OpenAI transport migration specifically, see [OpenAI Responses Migration Report](./OPENAI_RESPONSES_MIGRATION_REPORT.md).
