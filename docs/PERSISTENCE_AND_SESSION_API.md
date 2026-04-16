# Persistence And Session API

This page covers durable storage and the built-in HTTP-friendly session layer.

## Session Store Options

The library ships with three store patterns:

- `InMemorySessionStore`
  Good for tests and single-process local development
- `PostgresSessionStore`
  Durable production storage with tenant scoping
- `RedisSessionStore`
  Bring-your-own Redis client for cache-style storage

## In-Memory Storage

```ts
import { InMemorySessionStore, LLMClient } from 'unified-llm-client';

const sessionStore = new InMemorySessionStore();

const client = new LLMClient({
  defaultModel: 'gpt-4o',
  sessionStore,
});
```

This store is process-local. If the process restarts, the session history is gone.

## Postgres Storage

```ts
import { LLMClient, PostgresSessionStore } from 'unified-llm-client';

const sessionStore = PostgresSessionStore.fromEnv();

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
  sessionStore,
});
```

Important notes:

- `DATABASE_URL` must exist in the consuming application environment.
- The store creates its schema/table lazily on first use.
- Session rows are scoped by `tenantId` when provided.

### Automatic Postgres Wiring

If you call `LLMClient.fromEnv()` and `DATABASE_URL` is present, the library automatically uses `PostgresSessionStore.fromEnv()` for `conversation()` calls unless you pass an explicit `sessionStore`.

That means the following is enough for many projects:

```ts
const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const conversation = await client.conversation({
  sessionId: 'support-123',
});
```

## Redis Storage

`RedisSessionStore` works with a client you provide.

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

Your Redis client must implement:

- `get()`
- `set()`
- `del()`
- `scanIterator()` or `keys()`

Redis is useful when you want fast session storage with TTL-based expiry, but it is not a substitute for analytics storage.

## Usage Logging And Aggregation

If you want per-request analytics and exportable aggregates, add a usage logger.

### Console Logger

```ts
import { ConsoleLogger, LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
  usageLogger: new ConsoleLogger(),
});
```

This is helpful during development because it prints sanitized usage events.

### Postgres Usage Logger

```ts
import { LLMClient, PostgresUsageLogger } from 'unified-llm-client';

const usageLogger = PostgresUsageLogger.fromEnv();

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
  usageLogger,
});
```

After requests have been logged, aggregate usage like this:

```ts
const usage = await client.getUsage({
  tenantId: 'tenant-1',
});

const csv = await client.exportUsage('csv', {
  tenantId: 'tenant-1',
});

console.log(usage.totalCostUSD);
console.log(csv);
```

Use `PostgresUsageLogger` when you need dashboards, billing reports, or operational monitoring by tenant, model, or session.

## Build An HTTP Session Layer

The library exports `createSessionApi()` so you can expose session operations over HTTP without rewriting the conversation logic yourself.

```ts
import {
  LLMClient,
  PostgresSessionStore,
  createSessionApi,
} from 'unified-llm-client';

const sessionStore = PostgresSessionStore.fromEnv();

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
  sessionStore,
});

const sessionApi = createSessionApi({
  client,
  sessionStore,
});

const response = await sessionApi.handle(
  new Request('https://example.test/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'support-123',
      system: 'Be concise.',
    }),
  }),
);
```

## Session API Endpoints

The built-in endpoints cover the full session lifecycle:

- `POST /sessions`
- `POST /sessions/{id}/message`
- `GET /sessions/{id}`
- `GET /sessions/{id}/messages`
- `DELETE /sessions/{id}`
- `POST /sessions/{id}/compact`
- `POST /sessions/{id}/fork`
- `GET /sessions`

Use the dedicated [SESSION_API_REFERENCE.md](./SESSION_API_REFERENCE.md) document for the full request and response contract.

## Add Authentication Or Tenant Context

`createSessionApi()` accepts middleware and request-context hooks so you can inject auth and tenant scoping.

```ts
const sessionApi = createSessionApi({
  client,
  sessionStore,
  middleware: [
    async (request) => {
      const tenantId = request.headers.get('x-tenant-id');
      return tenantId
        ? { tenantId }
        : Response.json({ error: 'Unauthorized' }, { status: 401 });
    },
  ],
});
```

This makes it practical to keep tenant-specific data separation inside your own application rules instead of hard-coding auth into the library.

## When To Use Which Layer

- Use `Conversation` directly when your app already has its own backend orchestration.
- Use `SessionApi` when you want a thin HTTP service for frontend clients or other services.
- Use Postgres when you want durable history.
- Use Redis when you want fast expiring state.
- Use a usage logger when you want analytics, billing, or monitoring.

## Next Step

If you are moving toward production traffic, continue with [Production Guide](./PRODUCTION_GUIDE.md).
