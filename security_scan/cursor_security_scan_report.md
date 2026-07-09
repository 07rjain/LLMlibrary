# Cursor Security Scan Report: unified-llm-client

**Date:** 2026-07-09  
**Repository:** chatbot101 (`unified-llm-client`)  
**Revision:** `ee9e5c66733f4adcb8cda517d9517a49e91c1428`  
**Scope:** Repository-wide  
**Validation:** Runtime PoCs against `dist/index.js` (findings 1–4, 6); static code trace (finding 5)

---

## Executive summary

This scan reviewed the LLM client library’s Session API, conversation/tool loop, RAG, provider adapters, redaction, and agent-file loading.

**6 reportable findings** were confirmed (3 high, 3 medium).  
All **8 findings from the June 2026 Codex audit** were re-checked and remain fixed (tool-result redaction, client override allowlist for config fields, RAG tenant ownership, secret redaction, skill path guards, HTML entity handling, Gemini cache path validation, local Claude `Bash(node *)` removal).

The library still has strong defaults in several places, but incomplete controls around **system-prompt ownership**, **snapshot restore trust**, and **strict tool-arg validation** are the highest-priority gaps.

| Field | Value |
| --- | --- |
| Reportable findings | 6 |
| Severity mix | High: 3 · Medium: 3 |
| Prior seeds re-verified | 8 fixed / suppressed |
| Auth in library | None (integrator middleware assumed) |

---

## Findings overview

| # | Severity | Confidence | Title |
| ---: | --- | --- | --- |
| 1 | High | High | Create-session can set `system` despite deny-by-default `allowClientOverrides` |
| 2 | High | High | `Conversation.restore` lets snapshot override caller `system` / `tenantId` / `budgetUsd` / `model` |
| 3 | High | High | Strict tool-arg validation bypass via `__proto__` / `constructor` keys |
| 4 | Medium | Medium | Required-field check uses `in` and accepts `Object.prototype` properties |
| 5 | Medium | Medium | SSE stream path lacks `AbortSignal` / client-disconnect cancellation |
| 6 | Medium | Medium | Snapshot-restored `maxToolRounds` / timeouts can be unbounded |

---

## Finding 1 — Create-session system prompt bypasses `allowClientOverrides`

| Field | Value |
| --- | --- |
| Severity | High |
| Confidence | High |
| Category | Authorization bypass / policy downgrade |
| CWE | CWE-15, CWE-862 |
| Location | `src/session-api.ts:320` (also `315–322`, `1019–1048`) |

### What’s wrong

`allowClientOverrides` correctly deny-lists `system` in `buildConversationOptions`, but `handleCreateSession` still applies `history.system` afterward from `body.system` or a leading `messages[].role === 'system'` entry.

### Impact

A client that can call `POST /sessions` can replace the server system prompt for that session (jailbreak / policy bypass), even when overrides are denied by default.

### Validation

Runtime PoC: `createSessionApi` with `conversationDefaults.system = 'SERVER_SYSTEM_PROMPT'` and no `allowClientOverrides`; create with a leading system message returned `session.system = 'ATTACKER_SYSTEM'`.

### Remediation

Only apply `history.system` / `body.system` when `allowedClientOverrides.has('system')`; otherwise keep `conversationDefaults.system`.

```typescript
// Vulnerable pattern (simplified)
const conversation = await this.client.conversation({
  ...this.buildConversationOptions(body, tenantId),
  messages: history.messages,
  ...(history.system !== undefined ? { system: history.system } : {}), // not gated
});
```

---

## Finding 2 — `Conversation.restore` prefers snapshot policy over caller options

| Field | Value |
| --- | --- |
| Severity | High |
| Confidence | High |
| Category | Trust boundary / insecure merge |
| CWE | CWE-915 |
| Location | `src/conversation.ts:350–374` (entrypoint via `src/client.ts` restore path) |

### What’s wrong

`Conversation.restore` spreads caller `options`, then overwrites `system`, `tenantId`, `budgetUsd`, `model`, and related policy fields from the snapshot. Tools / `maxToolRounds` / validation correctly prefer caller options in some cases; policy fields do not.

### Impact

A tampered or previously poisoned session snapshot (including one created via Finding 1) can defeat server-supplied policy and tenant context on restore.

### Validation

Runtime PoC: restore with trusted options vs hostile snapshot retained `EVIL_SYSTEM`, `attacker-tenant`, `budgetUsd: 999`, `attacker-model`.

### Remediation

Prefer caller options for `system`, `tenantId`, `budgetUsd`, `model`, `provider`, `providerOptions`, and `responseFormat`. Restore messages/history from the snapshot unless an explicit opt-in trusts snapshot policy.

---

## Finding 3 — Strict tool-arg validation bypass via `__proto__` / `constructor`

| Field | Value |
| --- | --- |
| Severity | High |
| Confidence | High |
| Category | Prototype pollution / input validation bypass |
| CWE | CWE-1321 |
| Location | `src/conversation.ts:1251` (also `1250–1260`, `1188–1231`) |

### What’s wrong

`validateToolObjectValue` looks up `properties[key]` on a normal object. Own keys `__proto__` / `constructor` resolve to `Object.prototype` / `Object` (truthy), so `additionalProperties: false` rejection is skipped. `validateToolSchemaValue` then falls through when `schema.type` is undefined.

### Impact

Default strict tool validation can be bypassed; polluted-shaped keys reach `tool.execute`.

### Validation

Runtime PoC: mock tool call with `args = {"__proto__":{"polluted":true},"city":"x"}` under `toolValidation: 'strict'` executed the tool and received the `__proto__` key.

### Remediation

- Use `Object.hasOwn(properties, key)` or null-prototype schema maps  
- Reject `__proto__` / `constructor` / `prototype` keys  
- Throw on unrecognized `schema.type`

---

## Finding 4 — Required checks use `in` (prototype pollution)

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | Medium |
| Category | Prototype pollution / input validation bypass |
| CWE | CWE-1321 |
| Location | `src/conversation.ts:1244` |

### What’s wrong

Required fields are checked with `key in value`, which is true for inherited `Object.prototype` properties.

### Impact

If the process prototype is polluted (including as an amplifier of Finding 3), empty own-arg objects can pass strict required validation and still execute.

### Validation

Runtime PoC: after `Object.prototype.city = 'inherited'`, strict tool call with `args: {}` executed successfully.

### Remediation

Replace `key in value` with `Object.hasOwn(value, key)`.

---

## Finding 5 — SSE streams ignore client disconnect / `AbortSignal`

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | Medium |
| Category | Denial of service / resource exhaustion |
| CWE | CWE-400 |
| Location | `src/session-api.ts:685` (also `672–690`) |

### What’s wrong

`streamSessionMessage` calls `conversation.sendStream(content)` without `request.signal` and without ReadableStream cancel wiring, even though `Conversation.sendStream` supports `AbortSignal`.

### Impact

Provider/tool work can continue after clients disconnect, enabling cost and resource exhaustion when streams are cheap to open.

### Validation

Static confirmation: `src/session-api.ts` has no `request.signal` usage; `sendStream` is invoked without a signal.

### Remediation

Pass `request.signal` into `sendStream`; abort on stream cancel; document integrator concurrency / rate limits.

---

## Finding 6 — Unbounded `maxToolRounds` / timeouts from snapshot

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | Medium |
| Category | Denial of service / resource exhaustion |
| CWE | CWE-770 |
| Location | `src/conversation.ts:353–357` |

### What’s wrong

When caller options omit `maxToolRounds` / `toolExecutionTimeoutMs`, restore accepts snapshot values including `Infinity` / huge timeouts without finite clamps. `assertNextToolRound` uses `nextRound > maxToolRounds`, which never trips for `Infinity`.

### Impact

Availability risk if an attacker can write snapshots and the server omits explicit tool-loop limits in restore options.

### Validation

Runtime restore with `maxToolRounds: Infinity` accepted the value; `1 > Infinity` is false for the assert used by the tool loop.

### Remediation

Clamp `maxToolRounds` and `toolExecutionTimeoutMs` to finite positive ranges; reject `Infinity` / `NaN` at construction and restore. Prefer always passing server defaults from Session API options.

---

## Surfaces reviewed (no new reportable issue)

| Surface | Outcome | Notes |
| --- | --- | --- |
| Tool-result redaction (SEED-01) | Fixed | JSON + SSE redact unless `exposeToolResults` |
| Client override allowlist for config fields (SEED-02) | Fixed | Residual is Finding 1 (system via history) |
| RAG tenant ownership (SEED-03) | Fixed | Upsert ownership asserts / SQL `WHERE` |
| Secret redaction (SEED-04) | Fixed | Prefixed keys redacted |
| `loadSkill` path traversal (SEED-05) | Fixed | Root required + containment |
| HTML entity crash (SEED-06) | Fixed | Invalid code points preserved |
| Gemini cache path injection (SEED-07) | Fixed | Name grammar + encode |
| Local Claude `Bash(node *)` (SEED-08) | Fixed | Narrow allowlist only |
| Missing built-in Session API auth | By design | Integrator middleware required |
| Trusted-context tenant resolution | Fixed | Request `tenantId` rejected by default |
| Provider `image_url` SSRF | Out of local scope | Adapters forward URLs; providers may fetch |
| RAG metadata SQL injection | Fixed | Parameterized `$n` / jsonb `@>` |
| Tool auto-exec “confused deputy” | By design | Consumer tools must authorize |

---

## Recommended fix order

1. Gate create-session `system` on `allowClientOverrides` (Finding 1)  
2. Make restore prefer caller policy / tenant fields (Finding 2)  
3. Harden tool-arg schema validation (`hasOwn`, reject prototype keys, throw on bad schema type) (Findings 3–4)  
4. Plumb stream abort / cancel (Finding 5)  
5. Clamp tool-loop limits on restore (Finding 6)

---

## Open follow-ups for integrators

- Never mount `createSessionApi` without authentication middleware.  
- Consider DB-level composite keys `(tenant_id, id)` for RAG tables in addition to app-layer ownership checks.  
- If accepting untrusted multimodal content, allowlist/block `image_url` destinations before calling providers.

---

## Artifact references

| Artifact | Path |
| --- | --- |
| This report | `security_scan/cursor_security_scan_report.md` |
| Canonical scan bundle | `security_scan/ee9e5c6_20260709T114052Z/` |
| Projected Codex-style report | `security_scan/codex_security_scan_20260709_report.md` |
| Prior audit (2026-06-30) | `security_scan/codex_security_scan_20260630_report.md` |
| Prior verification (2026-07-07) | `security_scan/security_audit_final_verification_20260707.md` |
