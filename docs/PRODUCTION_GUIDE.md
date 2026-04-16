# Production Guide

This page covers the parts of the library that matter once the first happy-path integration already works.

## Route Traffic With `ModelRouter`

`ModelRouter` lets you centralize model selection logic instead of scattering it across request handlers.

```ts
import { LLMClient, ModelRouter } from 'unified-llm-client';

const router = new ModelRouter({
  rules: [
    {
      name: 'tool-traffic',
      match: { hasTools: true },
      target: { provider: 'openai', model: 'gpt-4o' },
      fallback: [{ provider: 'openai', model: 'gpt-4o-mini' }],
    },
    {
      name: 'default-fast-path',
      target: { provider: 'openai', model: 'gpt-4o-mini' },
    },
  ],
});

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o-mini',
  modelRouter: router,
});
```

Common reasons to add a router:

- Send tool-heavy traffic to a model with stronger tool support
- Keep low-value requests on a cheaper model
- Define fallback chains during provider outages
- Run deterministic weighted experiments

## Use Budget Policies Intentionally

Both request-level and conversation-level calls accept budget controls.

```ts
const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
  budgetExceededAction: 'warn',
  onWarning: (message) => {
    console.warn('llm warning', message);
  },
});
```

You can also override budget behavior per call:

```ts
await client.complete({
  budgetUsd: 0.05,
  budgetExceededAction: 'throw',
  messages: [{ role: 'user', content: 'Write a short answer.' }],
});
```

Use:

- `throw` when overspend is unacceptable
- `warn` when you want observability without interruption
- `skip` when you want a graceful no-call fallback

## Choose The Right Runtime

The core client surface is safe for Edge-style runtimes:

- `LLMClient`
- `Conversation`
- `SessionApi`
- in-memory storage
- routing and utility helpers

Node-only features are loaded lazily:

- `PostgresSessionStore`
- `PostgresUsageLogger`

Practical rule:

- Use Edge for stateless request execution and streaming.
- Use Node when you need Postgres-backed persistence or usage aggregation in-process.

## Logging And Data Hygiene

The library sanitizes logged usage and error payloads before writing them through the built-in logging paths, but you still need to decide what your own application logs.

Recommended production posture:

- Log request ids, session ids, tenant ids, model ids, finish reasons, duration, and cost.
- Avoid logging raw prompts or tool payloads unless you have a clear compliance reason.
- Keep tool results narrow and structured so downstream logging stays predictable.

## Testing Without Live Providers

Use `LLMClient.mock()` for deterministic tests.

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.mock({
  responses: [
    {
      content: [{ type: 'text', text: 'MOCK_OK' }],
      finishReason: 'stop',
      model: 'mock-model',
      provider: 'mock',
      raw: null,
      text: 'MOCK_OK',
      toolCalls: [],
      usage: {
        cachedTokens: 0,
        cost: '$0.0000',
        costUSD: 0,
        inputTokens: 5,
        outputTokens: 2,
      },
    },
  ],
});

const response = await client.complete({
  messages: [{ role: 'user', content: 'Ping' }],
});
```

Use mock clients for:

- unit tests
- CI checks that must not depend on external APIs
- deterministic examples and snapshots

Keep live-provider tests opt-in and separate from the default test suite.

## Versioning And Reuse Across Projects

You can install directly from the GitHub repository:

```bash
pnpm add github:07rjain/LLMlibrary
```

For more stable reuse across projects, create tags and install a specific version:

```bash
pnpm add github:07rjain/LLMlibrary#v0.1.0
```

That gives consumers a pinned dependency instead of tracking `main`.

## Rollout Checklist

- Start with one provider and one model.
- Confirm the first `complete()` path in production-like logs.
- Add streaming only where it improves user experience.
- Add session persistence only where continuity matters.
- Add tool execution only when prompts alone are insufficient.
- Add usage logging before you need billing or cost attribution.
- Add routing rules after you have real traffic patterns to optimize against.
- Tag versions before multiple projects begin depending on the library.

## Supporting Docs

- API reference: [./api/index.html](./api/index.html)
- Session API contract: [../SESSION_API.md](../SESSION_API.md)
- Provider comparison: [PROVIDER_COMPARISON.md](./PROVIDER_COMPARISON.md)
- Cost policy: [COST_AND_PRICING.md](./COST_AND_PRICING.md)
