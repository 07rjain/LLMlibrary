# Security Findings Implementation Plan

Source reports:

- `security_scan/8649691_20260615T135727Z/report.md`
- `security_scan/8649691_20260615T135727Z/recheck.md`

Status: planning only. No source fixes are included in this document.

## Goals

Fix the seven validated findings while preserving the library's current public shape where reasonable. Prefer secure defaults for HTTP-exposed and model-directed execution paths, with explicit opt-in compatibility flags only where breaking behavior is likely.

## Priority Order

1. Fix direct exposure and injection paths: tenant resolution, error serialization, transcription URL fetching, pgvector SQL generation.
2. Fix model-directed tool execution guardrails: schema validation and cooperative cancellation.
3. Add retrieval guardrails or documentation for the in-memory store.
4. Run focused regression tests first, then the full project gate.

## Finding 1: Caller-Selected Tenant IDs In `SessionApi`

### Risk

When no middleware sets `requestContext.tenantId`, `SessionApi` falls back to `tenantId` supplied in the request body or query string. In multi-tenant deployments this can allow cross-tenant session reads or mutations if session IDs and tenant IDs are known or guessed.

### Proposed Change

Add an explicit tenancy mode to `SessionApiOptions`, for example:

```ts
tenantResolution?: 'trusted-context' | 'legacy-request-tenant' | 'single-tenant'
```

Security-fix default:

- Default to `trusted-context`.
- `trusted-context`: require middleware-provided `requestContext.tenantId` for tenant-scoped operations. Reject request-supplied tenant IDs from body or query by default.
- `single-tenant`: allow no tenant ID, but reject request-supplied tenant IDs.
- `legacy-request-tenant`: preserve current query/body tenant behavior only when explicitly configured. This is an opt-in compatibility escape hatch and is not the secure default.

Do not leave the current request-tenant behavior as the default in this fix. If maintainers need backwards compatibility, require them to opt in with `tenantResolution: 'legacy-request-tenant'` and document it as unsafe for public multi-tenant APIs.

### Code Areas

- `src/session-api.ts`
- `test/session-api.test.ts`
- `SESSION_API.md`
- `docs/SESSION_API_REFERENCE.md`

### Tests

- Request-supplied `tenantId` is rejected unless legacy mode is enabled.
- Middleware tenant wins over body/query tenant.
- Cross-tenant create, message send, get session, get messages, delete, compact, fork, and list/session enumeration cannot switch tenant via query or body.
- Every route that currently calls `resolveTenantId()` has direct coverage for body/query tenant switching, including list coverage for `GET /sessions?tenantId=...`.
- Single-tenant mode rejects unexpected `tenantId`.

## Finding 2: Unsanitized HTTP/SSE Error Details

### Risk

`LLMError.toJSON()` redacts secrets, but `SessionApi` manually serializes raw `message` and `details`. Provider or application errors can leak API keys, bearer tokens, DB URLs, headers, prompts, or internal service details.

### Proposed Change

Introduce external error serialization helpers:

```ts
serializeHttpError(error: unknown): PublicSessionApiError
serializeSseError(error: unknown): PublicSessionApiError
```

External responses should include only:

- stable `name` or error `code`
- safe generic `message`
- `provider` and `statusCode` only when useful and non-sensitive
- optional `requestId` / correlation id

Do not return raw `details`, `cause`, stack, provider response bodies, headers, prompts, or arbitrary generic error messages. If diagnostics must be exposed, pass them through recursive redaction and an allowlist.

### Code Areas

- `src/session-api.ts`
- `src/redaction.ts`
- `src/errors.ts`
- `test/session-api.test.ts`

### Tests

- JSON error response redacts nested `apiKey`, `authorization`, `databaseUrl`, `token`, bearer strings, OpenAI/Gemini-like keys.
- SSE `response.error` redacts the same data.
- Generic `Error` messages with secrets are not returned raw.
- `HttpError` validation messages remain user-safe.

## Finding 3: Tool Schemas Are Not Enforced

### Risk

Model output is untrusted. The current tool loop forwards `toolCall.args` directly into local `execute()` callbacks even when `CanonicalTool.parameters` declares a schema.

### Proposed Change

Implement a lightweight validator for `CanonicalToolSchema` and validate before callback execution.

Default behavior:

- reject unknown object properties unless an explicit schema option permits them
- require declared `required` fields
- enforce primitive types, arrays, nested objects, and enum values
- enforce integer vs number where applicable
- return a structured `tool_result` error instead of invoking the callback on invalid args

Add an explicit validation mode on both direct conversation usage and `SessionApi` conversation configuration:

```ts
interface ConversationOptions {
  toolValidation?: 'strict' | 'permissive'
}

interface SessionConversationConfig {
  toolValidation?: 'strict' | 'permissive'
}
```

`SessionApi.buildConversationOptions()` must pass `toolValidation` through from `conversationDefaults` and per-request config into `client.conversation()`. Strict validation is the secure default. `permissive` is an explicit opt-in compatibility mode.

### Code Areas

- `src/conversation.ts`
- `src/tools.ts`
- `src/types.ts`
- `test/conversation.test.ts`
- `test/tools.test.ts`

### Tests

- Extra fields rejected.
- Missing required fields rejected.
- Wrong primitive types rejected.
- Integer rejects floats and strings.
- Nested object and array schemas are enforced.
- Provider-specific tool-call encodings still normalize before validation.
- Invalid tool call produces a tool error part and does not call `execute()`.
- `SessionApi` propagates `toolValidation` from defaults and request config into created/restored conversations.

## Finding 4: Tool Timeout Does Not Cancel Underlying Work

### Risk

The timeout races callback completion but cannot stop the underlying async operation. Side effects can continue after the conversation has timed out or moved on.

### Proposed Change

Pass an `AbortSignal` into every tool callback via `ToolExecutionContext`:

```ts
interface ToolExecutionContext {
  signal?: AbortSignal;
}
```

For each tool call:

- create a per-tool `AbortController`
- link parent conversation abort to the tool controller
- abort the tool controller on timeout
- return timeout as a structured tool error
- document that long-running callbacks must observe `context.signal`

Important limitation: JavaScript cannot forcibly kill arbitrary promises. The fix must be cooperative. The library can make cancellation observable and stop accepting late results, but callback authors must wire the signal into DB queries, fetch calls, queues, or other long-running work.

### Code Areas

- `src/conversation.ts`
- `src/types.ts`
- `docs/CONVERSATIONS_AND_TOOLS.md`
- `test/conversation.test.ts`

### Tests

- `context.signal.aborted` becomes true on timeout.
- Parent `AbortSignal` aborts active tool callbacks.
- Late callback completion does not mutate conversation state.
- Timeout still returns a structured tool error.
- Existing callbacks that ignore the signal still do not block `send()` beyond timeout.

## Finding 5: Transcription URL SSRF

### Risk

`OpenAIAdapter.transcribe()` fetches `input.url` from the library runtime. If external users can submit URLs, the server can be used to reach metadata endpoints, localhost, private networks, or internal services.

### Proposed Change

Prefer bytes-first transcription:

- keep `file`, `data`, `Blob`, `ArrayBuffer`, `Uint8Array`
- make URL fetching disabled by default or guarded by explicit policy

Add a URL fetch policy:

```ts
transcriptionUrlPolicy?: {
  enabled: boolean;
  allowedProtocols?: ('https:' | 'http:')[];
  allowedHosts?: string[];
  blockPrivateNetworks?: boolean;
  maxBytes?: number;
  maxRedirects?: number;
}
```

Minimum secure default:

- reject `input.url` unless URL fetching is explicitly enabled
- allow `https:` only by default when enabled
- resolve hostnames and validate all resolved addresses before every fetch attempt
- block localhost, link-local, private IPv4 ranges, IPv6 loopback/link-local/unique-local ranges, and other non-public addresses
- use manual redirect handling, validate each redirect target before following it, and re-resolve/re-check the host at every hop
- enforce `maxRedirects` with a small default such as 3
- enforce `maxBytes` while streaming the response body, not after `response.blob()` has already buffered it
- reject responses without an acceptable audio content type unless the policy explicitly disables content-type checks

### Code Areas

- `src/client.ts`
- `src/providers/openai.ts`
- `src/types.ts`
- `test/openai.adapter.test.ts`
- `test/client.test.ts`
- `docs/SPEECH.md`

### Tests

- `http://169.254.169.254/...` rejected.
- localhost and `127.0.0.1` rejected.
- RFC1918 IPv4 ranges rejected.
- IPv6 loopback/link-local rejected.
- hostnames resolving to private or link-local addresses rejected.
- redirects to blocked hosts rejected.
- redirect chains are manually followed and every hop is revalidated.
- oversized audio response rejected.
- oversized audio response is stopped during streaming before full buffering.
- allowed HTTPS host succeeds when policy permits it.

## Finding 6: pgvector SQL Injection Via `dimensions`

### Risk

`createPgvectorHnswIndexSql()` interpolates `options.dimensions` directly into generated SQL. A string-cast or untrusted config value can append SQL before migration/setup code executes the returned DDL.

### Proposed Change

Validate dimensions before SQL construction:

```ts
function assertPgvectorDimensions(value: unknown): number
```

Requirements:

- type must be `number`
- finite
- integer
- positive
- `1 <= dimensions <= 16000`

Reject strings even if numeric-looking to avoid permissive coercion.

### Code Areas

- `src/retrieval.ts`
- `test/retrieval.test.ts`

### Tests

- malicious string payload rejected.
- numeric string rejected.
- `NaN`, `Infinity`, float, zero, negative, and huge values rejected.
- rejected malicious values do not appear anywhere in generated SQL or thrown error messages that might later be logged/executed as SQL.
- valid dimensions produce unchanged SQL.

## Finding 7: In-Memory Knowledge Store Match-All Filter

### Risk

`InMemoryKnowledgeStore` returns all ready chunks when no filter is supplied. This is convenient for demos but unsafe in shared multi-tenant usage.

### Proposed Change

Add an explicit option:

```ts
createInMemoryKnowledgeStore({
  allowUnfilteredSearch?: boolean
})
```

Default options:

- Default `allowUnfilteredSearch` to `false`.
- When `allowUnfilteredSearch` is `false`, dense and lexical searches throw if `filter` is missing.
- When `allowUnfilteredSearch` is `true`, preserve current match-all behavior for demos, tests, and explicitly single-tenant apps.

Do not add a second `requireFilter` API; use only `allowUnfilteredSearch` to avoid contradictory configuration.

### Code Areas

- `src/retrieval.ts`
- `test/retrieval.test.ts`
- `README.md`
- `docs/RETRIEVAL_API_INTEGRATION_REPORT.md`

### Tests

- unfiltered search throws or is rejected when guard is enabled.
- explicit tenant filter returns only that tenant.
- demo compatibility mode still allows match-all.
- lexical and dense search use the same guard.

## Implementation Sequence

1. Add failing regression tests for findings 2, 5, and 6 first. These are narrow and high-signal.
2. Implement fixes for findings 2, 5, and 6.
3. Add tenant-resolution tests and implement the `SessionApi` tenancy mode.
4. Add tool validation tests and implement schema validation.
5. Add tool cancellation tests and pass `AbortSignal` into callbacks.
6. Add in-memory retrieval guard tests and implement the chosen compatibility behavior.
7. Update docs and examples.
8. Run targeted tests after each group.
9. Run full quality gate.

## Suggested Verification Commands

```bash
pnpm vitest run test/session-api.test.ts
pnpm vitest run test/conversation.test.ts
pnpm vitest run test/openai.adapter.test.ts
pnpm vitest run test/retrieval.test.ts
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Final gate:

```bash
pnpm run ci
```

## Compatibility Notes

- Tenant behavior and transcription URL fetching are the most likely breaking changes. Use explicit options and release notes.
- Tool schema validation may break callbacks that currently rely on coercion or extra fields. A temporary permissive mode can reduce migration pain.
- Cooperative cancellation cannot guarantee that callback code stops unless the callback observes `context.signal`.
- In-memory retrieval is likely used in tests and demos, so any secure default may need test updates and documentation.

## Acceptance Criteria

- All seven findings have regression tests.
- Reproduction snippets from `recheck.md` no longer demonstrate the vulnerable behavior under secure defaults.
- Compatibility escape hatches, if included, are explicit and documented as unsafe or legacy behavior.
- `pnpm ci` passes.
