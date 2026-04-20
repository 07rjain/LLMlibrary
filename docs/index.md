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
5. [Production Guide](./PRODUCTION_GUIDE.md)

If you want the lower-level generated API surface, open [API Reference](./api/index.html).

For provider-specific implementation planning, see [Prompt Caching Report](./PROMPT_CACHING_REPORT.md).
Prompt caching work is tracked in the repository root as `prompt_caching_todo.md`.
For the OpenAI transport migration specifically, see [OpenAI Responses Migration Report](./OPENAI_RESPONSES_MIGRATION_REPORT.md).
