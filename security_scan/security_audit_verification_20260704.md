# Security Audit Fix Verification: security_audit

## Summary

Branch verified: `security_audit`

Original report reviewed: `security_scan/codex_security_scan_20260630_report.md`

Result: the security fixes for the 8 reported findings are present in `src`, and the original exploit PoCs are blocked after regenerating `dist-types` with `pnpm typecheck`.

Live test result: mostly passing. The live suite run from `dist-types/test` with its `.env` passed 19 of 20 tests. The only failing live test is Anthropic, caused by provider account credit balance, not by a code assertion.

## Commands Run

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm vitest run test/session-api.test.ts test/agent-files.test.ts test/chunking.test.ts test/redaction.test.ts test/gemini.adapter.test.ts test/retrieval.postgres.test.ts test/retrieval.test.ts` | Failed: 134/137 passed; 3 existing `SessionApi` expectations conflict with the new deny-by-default security policy |
| `LIVE_REAL_TESTS=1 pnpm vitest run ...` from `dist-types/test` | Failed: 19/20 passed; Anthropic failed because the account has insufficient credits |

The live command was run with `dist-types/test` as the working directory so `dist-types/test/.env` was the dotenv source used by the live helper.

## Finding-by-Finding Verification

### 1. Session API exposes raw tool results to public clients

Status: Fixed in source and regenerated `dist-types`.

Evidence:

- `src/session-api.ts` now defaults `exposeToolResults` to `false`.
- Public session projections call `projectMessagesForClient(...)`.
- `tool_result` parts are preserved structurally but their payload is replaced with `[tool result withheld]`.

Regression PoC result:

```json
{"status":200,"toolResult":{"isError":false,"name":"query_user_database","result":"[tool result withheld]","toolCallId":"tool_secret","type":"tool_result","redacted":true}}
```

### 2. Public Session API request body can override server conversation policy

Status: Fixed in source and regenerated `dist-types`.

Evidence:

- `src/session-api.ts` now has `allowClientOverrides`.
- Default policy denies all request-body conversation-policy overrides.
- `buildConversationOptions()` starts from trusted `conversationDefaults` and copies only allowlisted fields.

Regression PoC result:

```json
{"status":200,"executions":[],"toolResult":{"isError":true,"name":"validated_tool","result":"[tool result withheld]","toolCallId":"tool_1","type":"tool_result","redacted":true},"responseText":"done"}
```

The invalid tool call did not execute, so the client-supplied `toolValidation: permissive` override was blocked.

### 3. Global knowledge object IDs can be reassigned across tenants on upsert conflict

Status: Fixed for both in-memory and Postgres stores.

Evidence:

- In-memory upserts call `assertKnowledgeRecordOwnership(...)` before overwriting existing objects.
- Postgres upserts now include tenant/bot ownership checks in the conflict update `WHERE` clause and assert that the upsert returned a row.

Regression PoC result:

```json
{"blocked":true,"name":"LLMError","message":"Cannot upsert knowledge space \"space_same\": it belongs to a different tenant. Knowledge record ids are tenant-scoped; use a new id."}
```

### 4. Provider-prefixed secret fields bypass key-name redaction

Status: Fixed.

Evidence:

- `src/redaction.ts` now matches sensitive substrings/suffixes, not only exact key names.
- Usage metric fields like `inputTokens` and `maxTokens` are preserved.

Regression PoC result:

```json
{"openaiApiKey":"[REDACTED]","gemini_api_key":"[REDACTED]","apiKey":"[REDACTED]","inputTokens":123,"maxTokens":456}
```

### 5. `loadSkill(string)` can read skill markdown outside the resolved agent root

Status: Fixed.

Evidence:

- `loadSkill(string)` now requires a trusted `root` option.
- Paths are resolved against that root and checked with containment validation.

Regression PoC result:

```json
{"blocked":true,"name":"AgentFilesError","message":"loadSkill() requires a trusted \"root\" option when given a string path. Pass a manifest from discoverSkills() or set options.root."}
```

### 6. Out-of-range HTML entity crashes untrusted document normalization

Status: Fixed.

Evidence:

- `src/chunking.ts` now validates numeric code points with `isValidCodePoint(...)`.
- Invalid and surrogate code points are left as literal entities instead of being passed to `String.fromCodePoint()`.

Regression PoC result:

```json
{"ok":true,"out":"start &#9999999999; end and &#xD800;"}
```

### 7. Gemini cache names are interpolated into authenticated API URLs without path validation

Status: Fixed.

Evidence:

- `normalizeGeminiCachedContentName(...)` now accepts only cache IDs matching `/^[A-Za-z0-9_-]+$/`.
- Valid IDs are URL-encoded before being added to the request path.

Regression PoC result:

```json
{"name":"../../models?alt=json","blocked":true,"error":"Invalid Gemini cache name \"../../models?alt=json\". Expected \"cachedContents/<id>\" where id matches /^[A-Za-z0-9_-]+$/."}
{"name":"cachedContents/../../models?alt=json","blocked":true,"error":"Invalid Gemini cache name \"cachedContents/../../models?alt=json\". Expected \"cachedContents/<id>\" where id matches /^[A-Za-z0-9_-]+$/."}
{"name":"cache_1","blocked":false}
```

### 8. Local Claude settings allow arbitrary Node commands

Status: Not verified as fixed.

Evidence:

- `.claude/settings.local.json` is ignored and local-only.
- The verification focused on repository code and generated dist-types output. I did not modify or remove the local permission file.

Recommended action:

- Remove `Bash(node *)` locally or replace it with narrower project-specific commands.

## Live Test Results

Live tests were run from `dist-types/test` using its `.env`.

Passed:

- `test/live-real/sessions-tools.test.ts`: 6/6
- `test/live-real/budgets-retrieval-security.test.ts`: 9/9
- `test/live-real/providers.test.ts`: OpenAI paths passed, Gemini paths passed, budget/cancellation and secret-redaction provider tests passed

Failed:

- `test/live-real/providers.test.ts > uses Anthropic for completion, streaming, tools, and errors`
- Cause: Anthropic provider returned `Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.`

This is an external account/billing failure, not evidence that the code fix failed.

## Remaining Issues

### 1. `test/session-api.test.ts` has stale expectations

The targeted suite still has 3 failing `SessionApi` tests:

1. `persists responseFormat from session creation config`
2. `propagates toolValidation from session message config into conversations`
3. `covers alternate create, list, compact, fork, and error-mapping branches`

These tests expect request-body conversation-policy fields to be accepted by default. The security fix intentionally changed the default to deny client overrides. The tests should be updated to either:

- assert deny-by-default behavior, or
- pass `allowClientOverrides` when testing trusted legacy override behavior.

### 2. `dist-types/src` direct Node execution misses `node-pg-loader.js`

Direct Node execution against `dist-types/src/session-store.js` and `dist-types/src/retrieval.js` fails with:

```text
Cannot find module 'dist-types/src/node-pg-loader.js'
```

This did not block the Vitest live run because Vitest executed the TypeScript source tests, but it means direct runtime use of the generated `dist-types/src` tree is incomplete unless `node-pg-loader.js` is copied there or the declaration-build output is not intended to be run directly.

## Conclusion

The seven repository-code findings are fixed in source and reflected in regenerated `dist-types` output. The local Claude allowlist finding remains a local workstation policy item and was not changed.

Before calling the branch fully clean, update the stale `SessionApi` tests and either fix or document the missing `dist-types/src/node-pg-loader.js` runtime artifact. Live provider/database coverage is otherwise good, with the only live failure caused by Anthropic account credits.

