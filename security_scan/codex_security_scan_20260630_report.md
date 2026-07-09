# Security Scan Report: unified-llm-client

## Summary

Codex Security completed a repository-wide standard scan of `unified-llm-client` at revision `49449df02e9a747f614fb50712e08c51229521e1`.

The scan reviewed 126 repository worklist items across source, tests, scripts, generated declarations, docs, local configuration, and prior scan artifacts. It found 8 reportable issues:

| Severity | Count |
| --- | ---: |
| High | 3 |
| Medium | 4 |
| Low | 1 |

Full generated report:

`/private/var/folders/z4/j0tv9gzs7xldkscc1jy5pg6w0000gn/T/codex-security-scans-OFWMlw/chatbot101/49449df02e9a747f614fb50712e08c51229521e1_20260630T215122Z_wqumq5xi/report.md`

SARIF export:

`/private/var/folders/z4/j0tv9gzs7xldkscc1jy5pg6w0000gn/T/codex-security-scans-OFWMlw/chatbot101/49449df02e9a747f614fb50712e08c51229521e1_20260630T215122Z_wqumq5xi/exports/results.sarif`

## Highest Priority Findings

### 1. Session API exposes raw tool results to public clients

- Severity: High
- File: `src/session-api.ts`
- Issue: Public session responses and SSE events can include persisted `tool_result` parts.
- Impact: Widget/browser clients may receive raw database or RAG rows before any assistant-level filtering.
- Fix: Treat tool results as server-internal by default. Public session views and streams should omit or redact tool results unless a tool explicitly marks output as public.

### 2. Public Session API request body can override server conversation policy

- Severity: High
- File: `src/session-api.ts`
- Issue: Request config is merged after trusted `conversationDefaults`.
- Impact: Public callers can downgrade `toolValidation`, alter model/system/provider options, or raise spend/tool execution limits.
- Fix: Split trusted server configuration from public request payloads. Reject or ignore policy fields from browser-facing routes unless trusted middleware explicitly permits them.

### 3. Global knowledge object IDs can be reassigned across tenants on upsert conflict

- Severity: High
- File: `src/retrieval.ts`
- Issue: Knowledge-space, source, and chunk upserts use global `id` conflicts and update ownership fields such as `tenant_id`.
- Impact: If ingestion accepts tenant-controlled or predictable IDs, one tenant may overwrite or take over another tenant's knowledge records.
- Fix: Make uniqueness tenant-scoped, such as `(tenant_id, id)`, or reject conflicts where the existing row belongs to a different tenant.

## Medium Findings

### 4. Provider-prefixed secret fields bypass key-name redaction

- File: `src/redaction.ts`
- Issue: `sanitizeForLogging()` redacts exact keys like `apiKey`, but not common prefixed names like `openaiApiKey` or `gemini_api_key`.
- Fix: Match sensitive suffixes/tokens such as `apikey`, `secret`, `token`, `password`, `credential`, and `connectionstring`.

### 5. `loadSkill(string)` can read skill markdown outside the resolved agent root

- File: `src/agent-files.ts`
- Issue: `loadSkill()` resolves and reads caller-supplied string paths without root containment checks.
- Fix: Require paths to stay inside the trusted `.agents/skills` root, or accept only manifests returned by `discoverSkills()`.

### 6. Out-of-range HTML entity crashes untrusted document normalization

- File: `src/chunking.ts`
- Issue: Numeric HTML entities are passed to `String.fromCodePoint()` after only checking `Number.isFinite()`.
- Impact: Malformed uploaded or crawled documents can throw `RangeError` and abort ingestion.
- Fix: Validate entity values are integer Unicode code points in the valid range before decoding.

### 7. Gemini cache names are interpolated into authenticated API URLs without path validation

- File: `src/providers/gemini.ts`
- Issue: Cache names are prefixed but not validated before URL interpolation.
- Impact: A caller-controlled cache name can alter the authenticated Google API path/query if exposed through an app wrapper.
- Fix: Validate cache resource names against an exact allowed grammar and URL-encode path segments.

## Low Finding

### 8. Local Claude settings allow arbitrary Node commands

- File: `.claude/settings.local.json`
- Issue: The local untracked allowlist contains `Bash(node *)`.
- Impact: This weakens local development command-approval guardrails, but is not part of the tracked package.
- Fix: Replace the broad pattern with narrowly scoped project commands.

## Validation Notes

Focused local proofs were run for the parser, redaction, Session API, agent-files, and Gemini cache candidates. The RAG tenant-conflict finding was statically validated from the in-memory and Postgres store implementations.

No live provider API calls or production database calls were used.

## Recommended Fix Order

1. Lock down `SessionApi` public response projection and request-policy handling.
2. Fix tenant-scoped uniqueness and conflict behavior in RAG stores.
3. Harden redaction and document normalization.
4. Add path/resource-name validation for `loadSkill()` and Gemini cache helpers.
5. Tighten the local Claude command allowlist.

