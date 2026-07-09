# Security Review: chatbot101 / unified-llm-client

## Scope

Repository-wide security scan of unified-llm-client (TypeScript LLM client library).

- Scan mode: repository
- Target kind: git_worktree
- Target ID: target_sha256_cdabcf0828be01ee8d6e46a7a85c6ca6ec919b0c54a78928a516cec74f86b345
- Revision: ee9e5c66733f4adcb8cda517d9517a49e91c1428
- Snapshot digest: codex-security-snapshot/v1:sha256:8a03bddf91b4caa2fa4fd2be3df55543cdd8174180ee96a91bb3e8366c0f262f
- Inventory strategy: repository
- Included paths: .
- Excluded paths: none
- Runtime or test status: Validated reportables against built dist/index.js with LLMClient.mock and createSessionApi harness.
- Artifacts reviewed: artifacts/01_context/threat_model.md, artifacts/01_context/seed_research.md, artifacts/02_discovery/rank_input.jsonl, artifacts/02_discovery/deep_review_input.jsonl, artifacts/02_discovery/finding_discovery_report.md, artifacts/03_coverage/repository_coverage_ledger.md, artifacts/05_findings/
- Scan context: Threat model was generated in Phase 1 for this scan. Prior June 2026 findings were treated as regression seeds and re-verified.

Limitations and exclusions:
- No Codex Security app workspace; terminal/chat workflow used.
- Goal tools unavailable in this host (suggest-level).
- Widget SaaS auth (cbw_live_\*) is documented but not implemented in-repo.
- Provider-side image_url fetches are outside local SSRF control.
- Excluded dist-types/\*\*: Generated TypeScript emit mirroring src/; security owned by src review
- Excluded Test_Droid/\*\*: Test fixtures; not a deployed runtime surface

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable findings | 6 |
| Severity mix | high: 3, medium: 3 |
| Confidence mix | high: 3, medium: 3 |
| Coverage | complete |
| Validation mode | runtime PoC for C-003/C-101/C-102/C-103/C-104; static trace for C-006 |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Library-first LLM client with Session API, conversation tool loop, RAG, and provider adapters. Primary risks are Session API policy/tenant boundaries, tool-arg validation, snapshot trust, secret redaction, and path/cache injection. Authn is an integrator responsibility.

### Assets

- Provider API keys
- Tenant session history
- Tool results / operational DB data
- Knowledge base embeddings
- Usage/billing metrics

### Trust Boundaries

- HTTP Session API
- Trusted middleware tenant context
- Model-to-tool execution
- Session/RAG stores
- Filesystem agent-files
- Provider network

### Attacker Capabilities

- Untrusted Session API clients
- Prompt-influenced model tool args
- Hostile documents for chunking
- Tampered store snapshots if store writable

### Security Objectives

- Deny-by-default client policy overrides
- Tool-result redaction by default
- Tenant isolation
- Strict tool validation
- Secret redaction
- Path/cache containment

### Assumptions

- Consumers authenticate SessionApi
- Tools enforce their own authorization
- Prior SEED findings remain fixed unless regression evidence shows otherwise

## Findings

| Finding | Severity | Confidence |
| --- | --- | --- |
| [Create-session history can set system prompt despite deny-by-default allowClientOverrides](#finding-1) | high | high |
| [Conversation.restore prefers snapshot system/model/budget/tenantId over caller options](#finding-2) | high | high |
| [Strict tool-arg schema validation bypass via __proto__/constructor keys](#finding-3) | high | high |
| [Required-field check uses in-operator and accepts Object.prototype properties](#finding-4) | medium | medium |
| [SSE stream path lacks AbortSignal / client-disconnect cancellation](#finding-5) | medium | medium |
| [Snapshot-restored maxToolRounds/timeouts unbounded when caller omits overrides](#finding-6) | medium | medium |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Create-session history can set system prompt despite deny-by-default allowClientOverrides

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Runtime PoC against dist createSessionApi returned session.system=ATTACKER_SYSTEM with allowClientOverrides omitted. |
| Category | Authorization bypass / policy downgrade |
| CWE | CWE-15, CWE-862 |
| Affected lines | src/session-api.ts:320, src/session-api.ts:315-322, src/session-api.ts:1019-1048 |

#### Summary

POST /sessions accepts body.system or a leading system message and applies it after buildConversationOptions, so attackers can replace the server system prompt even when allowClientOverrides denies the system field.

#### Root Cause

Server-owned system prompt is an allowClientOverrides-protected field, but handleCreateSession applies normalizeHistoryInput(...).system outside that allowlist.

**history.system applied after deny-by-default options merge** — `src/session-api.ts:317-322`

buildConversationOptions deny-lists system, but history.system is spread afterward unconditionally.

```typescript
    const conversation = await this.client.conversation({
      ...this.buildConversationOptions(body, tenantId),
      messages: history.messages,
      ...(history.system !== undefined ? { system: history.system } : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
```

#### Validation

Mounted createSessionApi with conversationDefaults.system=SERVER_SYSTEM_PROMPT and default deny-by-default overrides; POST /sessions with leading system message yielded session.system=ATTACKER_SYSTEM.

Validation method: runtime_poc

**history.system applied after deny-by-default options merge** — `src/session-api.ts:317-322`

buildConversationOptions deny-lists system, but history.system is spread afterward unconditionally.

```typescript
    const conversation = await this.client.conversation({
      ...this.buildConversationOptions(body, tenantId),
      messages: history.messages,
      ...(history.system !== undefined ? { system: history.system } : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
```

#### Dataflow

The canonical finding records the affected path at src/session-api.ts:320, src/session-api.ts:315-322, src/session-api.ts:1019-1048, but no expanded source-to-sink narrative was recorded.

**history.system applied after deny-by-default options merge** — `src/session-api.ts:317-322`

buildConversationOptions deny-lists system, but history.system is spread afterward unconditionally.

```typescript
    const conversation = await this.client.conversation({
      ...this.buildConversationOptions(body, tenantId),
      messages: history.messages,
      ...(history.system !== undefined ? { system: history.system } : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
```

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**High** — A reachable Session API create path lets untrusted clients override a server-owned system prompt that the library otherwise deny-lists. This enables jailbreaks and policy bypass for every subsequent turn in that session. Likelihood is high wherever SessionApi is mounted without additional body filtering; impact is integrity of conversation policy rather than direct RCE.

Severity would drop if create-session system input were gated on allowClientOverrides.has('system') or rejected by default; it would rise if combined with privileged tools and missing auth middleware.

#### Remediation

Only apply history.system / body.system when allowedClientOverrides.has('system'); otherwise ignore client system and keep conversationDefaults.system.

Tests:
- Assert POST /sessions with system message keeps conversationDefaults.system when allowClientOverrides omits system
- Assert allowClientOverrides including system still permits intentional override

Preventive controls:
- Treat system prompt as server-owned by default across all Session API entrypoints
- Add regression tests pairing allowClientOverrides with history normalization

<a id="finding-2"></a>

### [2] Conversation.restore prefers snapshot system/model/budget/tenantId over caller options

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Runtime Conversation.restore PoC showed snapshot system/tenantId/budgetUsd/model winning over conflicting caller options. |
| Category | Insecure object deserialization / trust boundary failure |
| CWE | CWE-915 |
| Affected lines | src/conversation.ts:350-374, src/client.ts:446 |

#### Summary

Conversation.restore spreads caller options then overwrites system, tenantId, budgetUsd, model, and related policy fields from the snapshot, so a tampered or previously poisoned store entry defeats server-supplied conversation policy on restore.

#### Root Cause

Restore merge order treats persisted snapshot policy as authoritative over the current server caller options.

**Snapshot fields overwrite caller options** — `src/conversation.ts:350-374`

After ...options, snapshot.budgetUsd/system/tenantId/model are applied unconditionally.

```typescript
    const conversation = new Conversation(client, {
      ...options,
      ...(snapshot.budgetUsd !== undefined ? { budgetUsd: snapshot.budgetUsd } : {}),
      ...(options.maxToolRounds !== undefined
        ? { maxToolRounds: options.maxToolRounds }
        : snapshot.maxToolRounds !== undefined
          ? { maxToolRounds: snapshot.maxToolRounds }
          : {}),
      ...(snapshot.maxContextTokens !== undefined
        ? { maxContextTokens: snapshot.maxContextTokens }
        : {}),
      ...(snapshot.maxTokens !== undefined ? { maxTokens: snapshot.maxTokens } : {}),
      messages: snapshot.messages,
      ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      ...(snapshot.provider !== undefined ? { provider: snapshot.provider } : {}),
      ...(snapshot.providerOptions !== undefined
        ? { providerOptions: snapshot.providerOptions }
        : {}),
      ...(snapshot.responseFormat !== undefined
        ? { responseFormat: snapshot.responseFormat }
        : {}),
      sessionId: snapshot.sessionId,
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(snapshot.system !== undefined ? { system: snapshot.system } : {}),
      ...(snapshot.tenantId !== undefined ? { tenantId: snapshot.tenantId } : {}),
```

#### Validation

Restored with conflicting options and snapshot; serialised conversation retained EVIL_SYSTEM, attacker-tenant, budget 999, attacker-model while maxToolRounds correctly preferred options.

Validation method: runtime_poc

**Snapshot fields overwrite caller options** — `src/conversation.ts:350-374`

After ...options, snapshot.budgetUsd/system/tenantId/model are applied unconditionally.

```typescript
    const conversation = new Conversation(client, {
      ...options,
      ...(snapshot.budgetUsd !== undefined ? { budgetUsd: snapshot.budgetUsd } : {}),
      ...(options.maxToolRounds !== undefined
        ? { maxToolRounds: options.maxToolRounds }
        : snapshot.maxToolRounds !== undefined
          ? { maxToolRounds: snapshot.maxToolRounds }
          : {}),
      ...(snapshot.maxContextTokens !== undefined
        ? { maxContextTokens: snapshot.maxContextTokens }
        : {}),
      ...(snapshot.maxTokens !== undefined ? { maxTokens: snapshot.maxTokens } : {}),
      messages: snapshot.messages,
      ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      ...(snapshot.provider !== undefined ? { provider: snapshot.provider } : {}),
      ...(snapshot.providerOptions !== undefined
        ? { providerOptions: snapshot.providerOptions }
        : {}),
      ...(snapshot.responseFormat !== undefined
        ? { responseFormat: snapshot.responseFormat }
        : {}),
      sessionId: snapshot.sessionId,
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(snapshot.system !== undefined ? { system: snapshot.system } : {}),
      ...(snapshot.tenantId !== undefined ? { tenantId: snapshot.tenantId } : {}),
```

#### Dataflow

The canonical finding records the affected path at src/conversation.ts:350-374, src/client.ts:446, but no expanded source-to-sink narrative was recorded.

**Snapshot fields overwrite caller options** — `src/conversation.ts:350-374`

After ...options, snapshot.budgetUsd/system/tenantId/model are applied unconditionally.

```typescript
    const conversation = new Conversation(client, {
      ...options,
      ...(snapshot.budgetUsd !== undefined ? { budgetUsd: snapshot.budgetUsd } : {}),
      ...(options.maxToolRounds !== undefined
        ? { maxToolRounds: options.maxToolRounds }
        : snapshot.maxToolRounds !== undefined
          ? { maxToolRounds: snapshot.maxToolRounds }
          : {}),
      ...(snapshot.maxContextTokens !== undefined
        ? { maxContextTokens: snapshot.maxContextTokens }
        : {}),
      ...(snapshot.maxTokens !== undefined ? { maxTokens: snapshot.maxTokens } : {}),
      messages: snapshot.messages,
      ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      ...(snapshot.provider !== undefined ? { provider: snapshot.provider } : {}),
      ...(snapshot.providerOptions !== undefined
        ? { providerOptions: snapshot.providerOptions }
        : {}),
      ...(snapshot.responseFormat !== undefined
        ? { responseFormat: snapshot.responseFormat }
        : {}),
      sessionId: snapshot.sessionId,
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(snapshot.system !== undefined ? { system: snapshot.system } : {}),
      ...(snapshot.tenantId !== undefined ? { tenantId: snapshot.tenantId } : {}),
```

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**High** — Session restore is the persistence trust boundary for SessionApi. Snapshot-wins merge lets store integrity failures (or C-003-written hostile system) override trusted caller options including tenantId and budgets.

Severity drops if caller options win for all policy fields; rises if store is multi-tenant without strong integrity controls.

#### Remediation

Prefer caller options for system, tenantId, budgetUsd, model, provider, providerOptions, and responseFormat; restore messages/history from snapshot unless an explicit opt-in trusts snapshot policy.

Tests:
- Restore with conflicting options/snapshot and assert options win for policy fields
- Assert SessionApi message path keeps conversationDefaults.system after hostile snapshot

Preventive controls:
- Separate history snapshot from policy snapshot
- Sign or integrity-check session snapshots in production stores

<a id="finding-3"></a>

### [3] Strict tool-arg schema validation bypass via __proto__/constructor keys

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Runtime Conversation PoC with toolValidation:strict executed lookup and received args containing own __proto__ key. |
| Category | Prototype pollution / input validation bypass |
| CWE | CWE-1321 |
| Affected lines | src/conversation.ts:1251, src/conversation.ts:1250-1260, src/conversation.ts:1188-1231 |

#### Summary

validateToolObjectValue uses properties\[key\] prototype-chain lookup, so own keys __proto__ or constructor resolve to Object.prototype/Object and skip additionalProperties rejection; polluted-shaped args reach tool.execute under strict validation.

#### Root Cause

Schema property maps are ordinary objects, so inherited keys masquerade as declared properties and unknown schema.type does not throw.

**Prototype-chain schema lookup for attacker keys** — `src/conversation.ts:1249-1260`

properties\['__proto__'\] is Object.prototype (truthy), so additionalProperties rejection is skipped; validateToolSchemaValue falls through when schema.type is undefined.

```typescript
  const properties = schema.properties ?? {};
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === true) {
        continue;
      }
      throw new Error(`${path}.${key} is not allowed.`);
    }

    validateToolSchemaValue(item, propertySchema, `${path}.${key}`);
  }
```

#### Validation

Mock tool_call with args JSON {"__proto__":{"polluted":true},"city":"x"} under strict validation executed the tool with the __proto__ key intact.

Validation method: runtime_poc

**Prototype-chain schema lookup for attacker keys** — `src/conversation.ts:1249-1260`

properties\['__proto__'\] is Object.prototype (truthy), so additionalProperties rejection is skipped; validateToolSchemaValue falls through when schema.type is undefined.

```typescript
  const properties = schema.properties ?? {};
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === true) {
        continue;
      }
      throw new Error(`${path}.${key} is not allowed.`);
    }

    validateToolSchemaValue(item, propertySchema, `${path}.${key}`);
  }
```

#### Dataflow

The canonical finding records the affected path at src/conversation.ts:1251, src/conversation.ts:1250-1260, src/conversation.ts:1188-1231, but no expanded source-to-sink narrative was recorded.

**Prototype-chain schema lookup for attacker keys** — `src/conversation.ts:1249-1260`

properties\['__proto__'\] is Object.prototype (truthy), so additionalProperties rejection is skipped; validateToolSchemaValue falls through when schema.type is undefined.

```typescript
  const properties = schema.properties ?? {};
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (!propertySchema) {
      if (schema.additionalProperties === true) {
        continue;
      }
      throw new Error(`${path}.${key} is not allowed.`);
    }

    validateToolSchemaValue(item, propertySchema, `${path}.${key}`);
  }
```

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**High** — Strict mode is the default security control for model-supplied tool arguments. A model-influenced payload can bypass additionalProperties:false and deliver prototype-pollution-shaped keys into consumer tools. Impact depends on tool implementations but breaks a core library invariant.

Severity lowers if Object.hasOwn is used and dangerous keys are rejected; rises if common tools merge args into prototypes or privileged objects.

#### Remediation

Use Object.hasOwn(properties, key) or Object.create(null) schema maps; reject __proto__/constructor/prototype keys; throw on unrecognized schema.type.

Tests:
- Strict schema with additionalProperties:false must reject own __proto__ and constructor keys
- Ensure execute is not called when those keys are present

Preventive controls:
- Null-prototype objects for schema dictionaries
- Fuzz tool-arg validation with prototype-pollution payloads

<a id="finding-4"></a>

### [4] Required-field check uses in-operator and accepts Object.prototype properties

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | Runtime PoC with Object.prototype.city polluted allowed empty args to execute under strict validation. |
| Category | Prototype pollution / input validation bypass |
| CWE | CWE-1321 |
| Affected lines | src/conversation.ts:1244, src/conversation.ts:1243-1247 |

#### Summary

Required tool-arg validation uses the in-operator, so inherited Object.prototype properties satisfy required checks and empty own-arg objects can reach tool.execute under strict mode when the prototype is polluted.

#### Root Cause

Required presence checks do not distinguish own properties from inherited ones.

**Required check uses in-operator** — `src/conversation.ts:1243-1247`

The in-operator is true for inherited prototype properties.

```typescript
  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
```

#### Validation

After defining Object.prototype.city, strict tool call with args {} executed successfully.

Validation method: runtime_poc

**Required check uses in-operator** — `src/conversation.ts:1243-1247`

The in-operator is true for inherited prototype properties.

```typescript
  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
```

#### Dataflow

The canonical finding records the affected path at src/conversation.ts:1244, src/conversation.ts:1243-1247, but no expanded source-to-sink narrative was recorded.

**Required check uses in-operator** — `src/conversation.ts:1243-1247`

The in-operator is true for inherited prototype properties.

```typescript
  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      throw new Error(`${path}.${key} is required.`);
    }
  }
```

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Requires prior prototype pollution (including via C-101 amplifiers or shared-process pollution). Alone it is medium; combined with C-101 it strengthens tool-arg integrity failure.

Severity drops with Object.hasOwn; rises if pollution is easy in the deployment process.

#### Remediation

Replace with Object.hasOwn(value, key).

Tests:
- With polluted Object.prototype.requiredKey, empty args must fail strict validation

Preventive controls:
- Ban prototype-pollution payloads in tool-arg fuzzing
- Use null-prototype objects for untrusted JSON where practical

<a id="finding-5"></a>

### [5] SSE stream path lacks AbortSignal / client-disconnect cancellation

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | Static confirmation that session-api.ts never references request.signal; Conversation.sendStream supports AbortSignal but is unused here. |
| Category | Denial of service / resource exhaustion |
| CWE | CWE-400 |
| Affected lines | src/session-api.ts:685, src/session-api.ts:672-690 |

#### Summary

streamSessionMessage calls conversation.sendStream(content) without request.signal and without ReadableStream cancel wiring, so provider/tool work can continue after clients disconnect.

#### Root Cause

SessionApi streaming ignores Fetch request cancellation despite Conversation supporting AbortSignal.

**sendStream invoked without signal** — `src/session-api.ts:680-690`

No AbortSignal is passed; disconnect cannot cancel the async iterator.

```typescript
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          controller.enqueue(encoder.encode(formatSseEvent('session.message.started', { sessionId })));

          for await (const chunk of conversation.sendStream(content)) {
            if (chunk.type === 'text-delta') {
              controller.enqueue(
                encoder.encode(formatSseEvent('response.text.delta', { delta: chunk.delta })),
              );
              continue;
```

#### Validation

rg/read confirmed no request.signal usage in src/session-api.ts while sendStream is called once in streamSessionMessage.

Validation method: static_code_trace

**sendStream invoked without signal** — `src/session-api.ts:680-690`

No AbortSignal is passed; disconnect cannot cancel the async iterator.

```typescript
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          controller.enqueue(encoder.encode(formatSseEvent('session.message.started', { sessionId })));

          for await (const chunk of conversation.sendStream(content)) {
            if (chunk.type === 'text-delta') {
              controller.enqueue(
                encoder.encode(formatSseEvent('response.text.delta', { delta: chunk.delta })),
              );
              continue;
```

#### Dataflow

The canonical finding records the affected path at src/session-api.ts:685, src/session-api.ts:672-690, but no expanded source-to-sink narrative was recorded.

**sendStream invoked without signal** — `src/session-api.ts:680-690`

No AbortSignal is passed; disconnect cannot cancel the async iterator.

```typescript
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          controller.enqueue(encoder.encode(formatSseEvent('session.message.started', { sessionId })));

          for await (const chunk of conversation.sendStream(content)) {
            if (chunk.type === 'text-delta') {
              controller.enqueue(
                encoder.encode(formatSseEvent('response.text.delta', { delta: chunk.delta })),
              );
              continue;
```

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Availability/cost impact via abandoned streams is realistic on public Session API mounts, but requires volume and does not by itself breach confidentiality.

Severity rises with expensive tools and no edge rate limits; lowers if request.signal is plumbed and cancel aborts the conversation stream.

#### Remediation

Pass request.signal into sendStream; abort on ReadableStream cancel; document integrator concurrency limits.

Tests:
- Aborting the request signal cancels an in-flight mock stream
- ReadableStream cancel triggers conversation cancellation

Preventive controls:
- Edge rate limits and max concurrent streams per tenant
- Server-side stream timeouts

<a id="finding-6"></a>

### [6] Snapshot-restored maxToolRounds/timeouts unbounded when caller omits overrides

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | Runtime restore accepted Infinity maxToolRounds; 1\>Infinity is false for the assert used by the tool loop. |
| Category | Denial of service / resource exhaustion |
| CWE | CWE-770 |
| Affected lines | src/conversation.ts:353-357, src/conversation.ts:634 |

#### Summary

When caller options omit maxToolRounds/toolExecutionTimeoutMs, restore accepts snapshot values including Infinity/MAX_SAFE_INTEGER without finite clamps, so assertNextToolRound never trips for Infinity.

#### Root Cause

Tool-loop limits from snapshots are not validated as finite positive integers.

**Snapshot maxToolRounds applied without finite clamp** — `src/conversation.ts:353-357`

??-style fallbacks do not reject Infinity/NaN; assertNextToolRound uses nextRound \> maxToolRounds.

```typescript
      ...(options.maxToolRounds !== undefined
        ? { maxToolRounds: options.maxToolRounds }
        : snapshot.maxToolRounds !== undefined
          ? { maxToolRounds: snapshot.maxToolRounds }
          : {}),
```

#### Validation

Restored snapshot with maxToolRounds=Infinity; live serial object retained Infinity and infinityNeverTripsAssert was true.

Validation method: runtime_poc

**Snapshot maxToolRounds applied without finite clamp** — `src/conversation.ts:353-357`

??-style fallbacks do not reject Infinity/NaN; assertNextToolRound uses nextRound \> maxToolRounds.

```typescript
      ...(options.maxToolRounds !== undefined
        ? { maxToolRounds: options.maxToolRounds }
        : snapshot.maxToolRounds !== undefined
          ? { maxToolRounds: snapshot.maxToolRounds }
          : {}),
```

#### Dataflow

The canonical finding records the affected path at src/conversation.ts:353-357, src/conversation.ts:634, but no expanded source-to-sink narrative was recorded.

**Snapshot maxToolRounds applied without finite clamp** — `src/conversation.ts:353-357`

??-style fallbacks do not reject Infinity/NaN; assertNextToolRound uses nextRound \> maxToolRounds.

```typescript
      ...(options.maxToolRounds !== undefined
        ? { maxToolRounds: options.maxToolRounds }
        : snapshot.maxToolRounds !== undefined
          ? { maxToolRounds: snapshot.maxToolRounds }
          : {}),
```

#### Reachability

Reachability was not recorded beyond the canonical finding summary and affected locations.

#### Severity

**Medium** — Availability impact requires snapshot write and omitted caller limits. Infinity comparison behavior was confirmed; JSON serialization may null Infinity but the live object retains it.

Severity drops with finite clamps; rises if SessionApi omits maxToolRounds defaults in options.

#### Remediation

Clamp maxToolRounds and toolExecutionTimeoutMs to finite positive ranges; reject Infinity/NaN at construction and restore.

Tests:
- Restore with maxToolRounds: Infinity must throw or clamp to DEFAULT_MAX_TOOL_ROUNDS

Preventive controls:
- Schema-validate ConversationSnapshot on read
- Always pass server maxToolRounds in SessionApi options

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Session API HTTP boundary | authz/policy/exposure | Reported | C-003 and C-006 reported; SEED-01/02 allowlist/tool-result suppressed; L-09 N/A; L-10 suppressed. Evidence: artifacts/05_findings/C-003/candidate_ledger.jsonl, artifacts/05_findings/C-006/candidate_ledger.jsonl, artifacts/05_findings/C-001/candidate_ledger.jsonl, artifacts/05_findings/C-002/candidate_ledger.jsonl |
| Conversation tool loop and restore | validation/snapshot-trust | Reported | C-101/C-102/C-103/C-104 reported; L-12 auto-exec suppressed as design. Evidence: artifacts/05_findings/C-101/candidate_ledger.jsonl, artifacts/05_findings/C-102/candidate_ledger.jsonl, artifacts/05_findings/C-103/candidate_ledger.jsonl, artifacts/05_findings/C-104/candidate_ledger.jsonl, artifacts/05_findings/C-105/candidate_ledger.jsonl |
| Retrieval / chunking | tenant-isolation/injection/parser | Rejected | SEED-03/06 and L-14 suppressed with ownership asserts, entity guards, parameterized filters. Evidence: artifacts/05_findings/C-201/candidate_ledger.jsonl, artifacts/05_findings/C-203/candidate_ledger.jsonl, artifacts/05_findings/C-204/candidate_ledger.jsonl |
| Agent skill file loading | path-traversal | Rejected | SEED-05 suppressed; root required and assertPathWithinRoot. Evidence: artifacts/05_findings/C-202/candidate_ledger.jsonl |
| Provider adapters | path-injection/ssrf/secrets | Rejected | SEED-07 suppressed; L-11 provider-side SSRF only; L-15 key plumbing OK. Evidence: artifacts/05_findings/C-302/candidate_ledger.jsonl, artifacts/05_findings/C-303/candidate_ledger.jsonl, artifacts/05_findings/C-304/candidate_ledger.jsonl |
| Redaction / errors / usage | secret-leakage | Rejected | SEED-04 suppressed; prefixed keys redacted. Evidence: artifacts/05_findings/C-301/candidate_ledger.jsonl |
| Local Claude settings | local-tooling | Rejected | SEED-08 suppressed; Bash(node \*) absent. Evidence: artifacts/05_findings/C-401/candidate_ledger.jsonl |
| dist-types generated emit | generated | Not applicable | Mirror of src; reviewed via src. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| Test_Droid fixtures | test-only | Not applicable | Not deployed runtime. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| scripts and build config | ci/dev | Not applicable | Secondary; deferred after high-impact src review. Closed as non-deployed CI/dev surface after high-impact src review. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| D-COMPACT | follow-up | Rejected | C-008 compact unbounded maxMessages/maxTokens low-confidence self-impact Reviewed; not promoted to reportable finding. Evidence: artifacts/05_findings/C-008/candidate_ledger.jsonl |
| D-STRUCTURED | follow-up | Rejected | C-110 structured-output client revalidation secondary Reviewed; not promoted to reportable finding. Evidence: artifacts/05_findings/C-110/candidate_ledger.jsonl |
| D-SCRIPTS | follow-up | Not applicable | scripts/config secondary after src high-impact review Closed as non-deployed CI/dev surface after high-impact src review. Evidence: artifacts/02_discovery/work_ledger.jsonl |

## Open Questions And Follow Up

- Integrators should confirm SessionApi is never mounted without auth middleware.
- Consider DB-level composite (tenant_id, id) for RAG tables beyond app-layer ownership asserts.
