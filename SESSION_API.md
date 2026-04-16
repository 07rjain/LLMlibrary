# Session API

Prepared: 2026-04-16

## Overview

The library exposes a framework-agnostic session API through [src/session-api.ts](src/session-api.ts). It is designed around standard web `Request` and `Response` objects instead of a specific server framework.

Use `createSessionApi({ client, sessionStore, ... })` to create a handler, then mount `sessionApi.handle(request)` inside your preferred runtime.

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

### Important runtime notes

- A session store is required. If the client was created with a store, `SessionApi` can reuse it.
- `contextManager` and executable `tools` are server-side configuration. They are passed back into restored conversations on each request because executable tools are not serializable inside session snapshots.
- `middleware` can resolve tenant identity or reject requests early.
- `withRequestContext(context, execute)` is the hook for RLS-style request scoping. Use it to set request-local DB session variables before store/client work runs.

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

Returns the session metadata and full history. Query parameter `include` accepts comma-separated values:

- `messages`
- `usage`
- `cost`

By default the handler includes `messages` and `cost` on this route. `usage` is included when explicitly requested and a usage logger with aggregation is configured.

### `GET /sessions/{id}/messages`

Returns paginated session history.

Supported query parameters:

- `cursor`
  Meaning: zero-based offset encoded as a string
- `limit`
  Range: `1..100`

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

This is intentionally stable and provider-agnostic. It exposes canonical library events rather than raw Anthropic/OpenAI/Gemini transport frames.

## Tenant Auth And RLS Context

`middleware` is the authentication/tenant-resolution layer.

Example shape:

```ts
const sessionApi = createSessionApi({
  client,
  middleware: [
    async (request) => {
      const tenantId = request.headers.get('x-tenant-id');
      return tenantId ? { tenantId } : Response.json({ error: 'Unauthorized' }, { status: 401 });
    },
  ],
  sessionStore,
  withRequestContext: async (context, execute) => {
    // Example place to set request-local DB session variables for RLS.
    // Exact implementation depends on your DB driver / connection management.
    return execute();
  },
});
```

Operational rule:

- If middleware resolves a tenant id, it overrides any tenant id the caller attempted to send in query/body parameters

## OpenAI Responses API Mapping

These notes cover `T-20`.

### `T-20.1`

`POST /sessions/{id}/message` is the functional equivalent of `previous_response_id`.

Reason:

- Instead of passing a previous response handle on every turn, the client pins continuity to the stored `sessionId`
- The handler loads the persisted session history, appends the new user input, runs the model, and stores the new state

### `T-20.2`

`sessionId` maps to the OpenAI concept of a conversation.

Practical interpretation:

- OpenAI Responses threads continuity through response linkage
- This library threads continuity through explicit persisted session snapshots

### `T-20.3`

`maxContextTokens + contextManager` maps to `context_management / compact_threshold`.

Practical interpretation:

- `maxContextTokens` is the threshold input
- `SlidingWindowStrategy` or `SummarisationStrategy` is the compaction policy
- `POST /sessions/{id}/compact` is the explicit/manual compaction trigger

### `T-20.4`

Future async/background handling design:

- Keep `POST /sessions/{id}/message` synchronous for the current implementation
- Add an optional async mode later that returns a job id immediately
- Persist intermediate job state separately from the session snapshot
- Reuse the same canonical session store so the final completion can still be merged into the session history
- Expose a future `GET /jobs/{id}` or SSE job-status stream instead of overloading the current synchronous endpoint

### `T-20.5`

`GET /sessions/{id}?include=messages,usage,cost` is the `include[]` equivalent.

Mapping:

- `messages`
  Equivalent intent: include the session history payload
- `usage`
  Equivalent intent: include aggregated usage data when the configured usage logger supports aggregation
- `cost`
  Equivalent intent: include stored session totals such as token/cost aggregates

## Error Model

The handler returns JSON errors with the shape:

```json
{
  "error": {
    "name": "ErrorName",
    "message": "Human-readable message"
  }
}
```

When the underlying library throws an `LLMError`, provider/status metadata is included when available.

## Current Scope

Implemented:

- Session lifecycle endpoints
- Pagination
- Manual compaction
- Forking
- Canonical SSE streaming
- Tenant middleware and request-context hook
- Responses-style mapping documentation

Not yet implemented:

- Background job execution
- Provider mock servers for E2E
- Cross-tenant integration stress tests
- OpenAI-native wire compatibility beyond the documented conceptual mapping
