# Session API Reference

This page documents the built-in framework-agnostic session API exposed by `createSessionApi()`.

Use this when you want your application or frontend to work with conversations over HTTP instead of instantiating `Conversation` directly inside the same process.

## Overview

The library exposes a session API through `createSessionApi({ client, sessionStore, ... })`.

It is intentionally built on top of standard web `Request` and `Response` objects, so it can be mounted in:

- Next.js route handlers
- Hono
- Cloudflare Workers
- Express or Fastify adapters
- plain Node HTTP wrappers

## Construction

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
```

## Important Runtime Notes

- A session store is required for durable API behavior.
- If the client already has a store configured, `SessionApi` can reuse it.
- `contextManager` and executable `tools` are server-side configuration, not client-submitted payloads.
- Middleware can resolve tenant identity or reject requests before any model call runs.
- `withRequestContext(context, execute)` is the hook for request-local DB scoping or RLS-style session setup.

## Endpoints

### `POST /sessions`

Creates and persists a new session snapshot.

Example body:

```json
{
  "sessionId": "support-123",
  "system": "Be concise.",
  "messages": [
    { "role": "user", "content": "Initial history item" }
  ],
  "model": "gpt-4o"
}
```

Returns `201` with:

- `session.id`
- `session.createdAt`
- `session.updatedAt`
- `session.messages`
- `session.totals`

### `POST /sessions/{id}/message`

Loads the stored session, appends one user input, runs the model, persists the updated snapshot, and returns the canonical response plus updated session state.

Example body:

```json
{
  "content": "Summarize the latest ticket."
}
```

If `stream=true` is passed in the query string or request body, the endpoint returns `text/event-stream`.

### `GET /sessions/{id}`

Returns the session metadata and full history.

The query parameter `include` accepts comma-separated values:

- `messages`
- `usage`
- `cost`

By default, this route includes `messages` and `cost`. `usage` is included when explicitly requested and a usage logger with aggregation support is configured.

### `GET /sessions/{id}/messages`

Returns paginated session history.

Supported query parameters:

- `cursor`
  Zero-based offset encoded as a string
- `limit`
  Range `1..100`

### `DELETE /sessions/{id}`

Deletes the stored session snapshot.

### `POST /sessions/{id}/compact`

Performs manual compaction against the stored session snapshot.

Options:

- Provide `maxMessages` and/or `maxTokens` in the body to use a one-off `SlidingWindowStrategy`
- Or configure `contextManager` when constructing `SessionApi`

### `POST /sessions/{id}/fork`

Creates a new session from an earlier point in the conversation.

Example body:

```json
{
  "fromMessageIndex": 3,
  "newSessionId": "support-123-branch",
  "resetUsage": true
}
```

Notes:

- `fromMessageIndex` is evaluated against the full session history, including the system message when present
- `resetUsage` defaults to `true`
- When `resetUsage` is `false`, the stored aggregate totals are copied into the fork unchanged

### `GET /sessions`

Lists tenant-scoped sessions with pagination.

Supported query parameters:

- `cursor`
- `limit`
- `model`
- `provider`
- `tenantId`

## Streaming Event Mapping

`POST /sessions/{id}/message?stream=true` emits canonical SSE events:

- `session.message.started`
- `response.text.delta`
- `response.tool_call.start`
- `response.tool_call.delta`
- `response.tool_call.result`
- `response.completed`
- `response.error`

These are canonical library events, not raw provider transport frames.

## Tenant Auth And RLS Context

`middleware` is the authentication and tenant-resolution layer.

Example:

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
  withRequestContext: async (context, execute) => {
    return execute();
  },
});
```

Operational rule:

- If middleware resolves a tenant id, it overrides any tenant id the caller attempted to send in body or query parameters

## OpenAI Responses API Mapping

### Previous Response Chains

`POST /sessions/{id}/message` is the provider-agnostic equivalent of building continuity from a prior response id.

Instead of resending a previous-response handle, the library anchors continuity to the stored `sessionId`.

### Conversation Identity

`sessionId` is the practical equivalent of a conversation or thread identifier.

### Context Management

`maxContextTokens + contextManager` maps to the same operational problem as compact-threshold style context management:

- `maxContextTokens` is the threshold
- `SlidingWindowStrategy` or `SummarisationStrategy` is the trimming policy
- `POST /sessions/{id}/compact` is the explicit manual trigger

### Future Async Handling

The current endpoint design is synchronous.

The intended future async shape is:

- keep `POST /sessions/{id}/message` for sync flows
- add an async mode that returns a job id immediately
- persist job state separately from the conversation snapshot
- merge the final completion back into the session history when done

### Include Semantics

`GET /sessions/{id}?include=messages,usage,cost` is the equivalent of asking for expanded response metadata in one request.

## Related Pages

- [Persistence And Session API](./PERSISTENCE_AND_SESSION_API.md)
- [Production Guide](./PRODUCTION_GUIDE.md)
- [API Reference](./api/index.html)
