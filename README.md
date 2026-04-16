# Unified LLM Client

Provider-agnostic TypeScript client for Anthropic, OpenAI, and Google Gemini with shared message types, streaming, conversations, cost tracking, and pluggable session storage.

## Features

- One `LLMClient` surface for Anthropic, OpenAI, and Gemini
- Canonical request/response types, including tools and multimodal parts
- `defineTool()` helper for typed tool definitions
- Non-streaming and streaming completions with explicit `stream.cancel()`
- Conversation state with running token and cost totals
- Automatic tool execution in conversations, including streaming pause/execute/resume
- Context trimming via sliding window or summarisation strategies
- Session persistence with `InMemorySessionStore`, `PostgresSessionStore`, and `RedisSessionStore`
- Automatic Postgres session persistence when `DATABASE_URL` is present
- Built-in framework-agnostic Session API handler with `Request`/`Response` endpoints
- Model routing, fallback chains, weighted A/B routing, and usage logging
- Budget breach policies: `throw`, `warn`, or `skip`
- Usage aggregation export as JSON or CSV
- Edge-safe core imports with Node-only Postgres features loaded lazily
- `LLMClient.mock()` for deterministic tests

## Install

### Use As A Library From GitHub

Once this repo is on GitHub, install it in another project with:

```bash
pnpm add github:07rjain/LLMlibrary
```

or:

```bash
pnpm add git+https://github.com/07rjain/LLMlibrary.git
```

The package runs `prepare` during Git installs, so the consumer project gets a built `dist` output automatically.

### Develop Locally

```bash
pnpm install
```

Create a local environment file from the example:

```bash
cp .env.example .env
```

## Environment

The library reads provider keys from environment variables when they are not passed directly.

```env
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENAI_ORG_ID=
OPENAI_PROJECT_ID=
GEMINI_API_KEY=
DATABASE_URL=
```

If `DATABASE_URL` is set, `LLMClient` will automatically use `PostgresSessionStore.fromEnv()` for `conversation()` calls unless you pass an explicit `sessionStore`.

## Quick Start

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const response = await client.complete({
  messages: [{ content: 'Say hello in one sentence.', role: 'user' }],
});

console.log(response.text);
console.log(response.usage.cost);
```

## Conversations

```ts
import { LLMClient, SlidingWindowStrategy } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const conversation = await client.conversation({
  contextManager: new SlidingWindowStrategy({
    maxMessages: 12,
    maxTokens: 16_000,
  }),
  sessionId: 'customer-support-1',
  system: 'You are concise and operational.',
});

await conversation.send('Summarise the last user issue.');
console.log(conversation.totals);
console.log(conversation.toMarkdown());
```

## Streaming

```ts
const stream = client.stream({
  messages: [{ content: 'Stream one sentence.', role: 'user' }],
});

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.delta);
  }
}

// Or cancel explicitly if the caller navigates away.
stream.cancel(new Error('Request no longer needed.'));
```

## Usage Export

```ts
const csv = await client.exportUsage('csv', {
  tenantId: 'tenant-1',
});

console.log(csv);
```

## Summarisation Strategy

`SummarisationStrategy` accepts a `summarizer()` callback. In production, point that callback at a cheaper model or internal summarisation service.

```ts
import { LLMClient, SummarisationStrategy } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const conversation = await client.conversation({
  contextManager: new SummarisationStrategy({
    keepLastMessages: 2,
    maxMessages: 10,
    summarizer: async (messages) => {
      const summary = await client.complete({
        messages: [
          {
            content: `Summarise this conversation history:\n${JSON.stringify(messages)}`,
            role: 'user',
          },
        ],
        model: 'gpt-4o-mini',
      });

      return summary.text;
    },
  }),
});
```

## Session Stores

### Postgres

```ts
import { LLMClient, PostgresSessionStore } from 'unified-llm-client';

const client = new LLMClient({
  defaultModel: 'gpt-4o',
  sessionStore: PostgresSessionStore.fromEnv(),
});
```

### Redis

`RedisSessionStore` is bring-your-own-client. Pass any Redis client that implements `get()`, `set()`, `del()`, and either `scanIterator()` or `keys()`.

```ts
import { LLMClient, RedisSessionStore } from 'unified-llm-client';

const sessionStore = new RedisSessionStore({
  client: redisClient,
  ttlSeconds: 3600,
});

const client = new LLMClient({
  defaultModel: 'gpt-4o',
  sessionStore,
});
```

## Session API

The package also exports a framework-agnostic session API handler. It accepts standard `Request` objects and returns standard `Response` objects, so it can be mounted in Express, Fastify, Hono, Next.js route handlers, Cloudflare Workers, or plain Node HTTP adapters.

```ts
import { LLMClient, PostgresSessionStore, createSessionApi } from 'unified-llm-client';

const store = PostgresSessionStore.fromEnv();
const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
  sessionStore: store,
});

const sessionApi = createSessionApi({
  client,
  sessionStore: store,
});

const response = await sessionApi.handle(
  new Request('https://example.test/sessions', {
    body: JSON.stringify({ sessionId: 'demo-session', system: 'Be concise.' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }),
);
```

Supported endpoints include:

- `POST /sessions`
- `POST /sessions/{id}/message`
- `GET /sessions/{id}`
- `GET /sessions/{id}/messages`
- `DELETE /sessions/{id}`
- `POST /sessions/{id}/compact`
- `POST /sessions/{id}/fork`
- `GET /sessions`

For the full endpoint contract and the OpenAI Responses-style mapping notes, see [SESSION_API.md](SESSION_API.md).

## Runtime Support

- Edge/browser-safe core surface: `LLMClient`, `Conversation`, routing, in-memory storage, utilities, and `SessionApi`
- Node-only persistence: `PostgresSessionStore` and `PostgresUsageLogger`
- Runtime safety probe: `pnpm edgecheck`

## Docs

- Documentation website: `https://07rjain.github.io/LLMlibrary/`
- User guide hub: [docs/README.md](docs/README.md)
- Getting started: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)
- Completions and streaming: [docs/COMPLETIONS_AND_STREAMING.md](docs/COMPLETIONS_AND_STREAMING.md)
- Conversations and tools: [docs/CONVERSATIONS_AND_TOOLS.md](docs/CONVERSATIONS_AND_TOOLS.md)
- Persistence and Session API: [docs/PERSISTENCE_AND_SESSION_API.md](docs/PERSISTENCE_AND_SESSION_API.md)
- Production guide: [docs/PRODUCTION_GUIDE.md](docs/PRODUCTION_GUIDE.md)
- Docs local dev server: `pnpm docs:dev`
- Docs production build: `pnpm docs:build`
- API reference source: `pnpm docs:api`
- Session API contract: [SESSION_API.md](SESSION_API.md)
- PRD decisions: [docs/PRD_DECISIONS.md](docs/PRD_DECISIONS.md)
- Provider comparison: [docs/PROVIDER_COMPARISON.md](docs/PROVIDER_COMPARISON.md)
- Migration guide: [docs/MIGRATION_GUIDE.md](docs/MIGRATION_GUIDE.md)
- Cost and pricing policy: [docs/COST_AND_PRICING.md](docs/COST_AND_PRICING.md)
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md)
- Current project state: [PROJECT_STATUS.md](PROJECT_STATUS.md)
- Validation handoff notes: [TEST_AGENT_HANDOFF.md](TEST_AGENT_HANDOFF.md)

## Quality And Performance

```bash
pnpm sizecheck
pnpm depcheck
pnpm edgecheck
pnpm bench:complete
pnpm bench:first-token
pnpm bench:memory
pnpm bench:concurrency
pnpm pricecheck
```

Optional live-provider smoke tests stay opt-in:

```bash
LIVE_TESTS=1 pnpm test:live
```

## Testing

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
