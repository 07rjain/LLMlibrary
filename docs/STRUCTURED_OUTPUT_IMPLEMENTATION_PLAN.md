# Structured Output Implementation Plan

## Summary

This plan adds first-class JSON and schema-constrained output support to
`unified-llm-client` without changing existing text completion behavior.

The library already supports structured tool arguments through
`CanonicalTool.parameters`, but it does not currently support provider-native
structured final answers. The new feature should be opt-in, provider-neutral,
and additive.

## Goals

- Add one cross-provider `responseFormat` option for completions and conversations.
- For streaming in v1, map `responseFormat` into provider requests but keep
  parsed structured output limited to `complete()` until the public stream chunk
  shape is intentionally extended.
- Support plain JSON object mode and JSON Schema structured output.
- Preserve `CanonicalResponse.text` as the compatibility surface.
- Add parsed structured output as an optional additive field.
- Map to OpenAI, Gemini, and Anthropic native APIs where supported.
- Keep normal users unaffected when they do not opt in.
- Avoid adding heavy runtime dependencies such as Zod.

## Non-Goals

- Do not replace tool calling. Tools remain the correct path for invoking app behavior.
- Do not guarantee semantic correctness of extracted data beyond provider schema adherence and optional local validation.
- Do not make structured output the default.
- Do not add SDK dependencies for provider-specific parsing helpers.
- Do not support every JSON Schema keyword in the first release.

## Provider Research

### OpenAI

OpenAI supports both JSON mode and schema-constrained Structured Outputs.

For the Responses API, the structured final-answer path uses `text.format`:

```ts
text: {
  format: {
    type: 'json_schema',
    name: 'contact_info',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['name', 'email'],
      additionalProperties: false,
    },
  },
}
```

JSON mode uses:

```ts
text: {
  format: { type: 'json_object' },
}
```

Important OpenAI behavior:

- Structured Outputs are preferred over JSON mode when a schema is available.
- JSON mode ensures valid JSON, not schema adherence.
- JSON mode requires an instruction to produce JSON in the prompt/context.
- Refusals may not match the requested schema and must remain detectable.
- `finishReason === 'length'` can mean the JSON is incomplete.

Source: https://developers.openai.com/api/docs/guides/structured-outputs

### Google Gemini

Gemini supports structured output through response MIME type and response
schema configuration. Google currently recommends the Interactions API for new
work, but this library uses raw `generateContent` in
`src/providers/gemini.ts`. Therefore this implementation must target the
documented `generateContent` REST shape first, not the Interactions API shape.

Expected mapping:

```ts
generationConfig: {
  responseFormat: {
    text: {
      mimeType: 'application/json',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name', 'email'],
      },
    },
  },
}
```

Important Gemini behavior:

- Gemini supports a subset of JSON Schema / OpenAPI-style schema fields.
- Unsupported schema keywords can produce request errors.
- Large or deeply nested schemas can be rejected.
- Tool calling and structured output combinations vary by model and API version.
- Do not implement the older `responseMimeType` / `responseSchema` mapping
  unless a live API verification proves it still works for the raw endpoint.

Sources:

- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/generate-content/structured-output

### Anthropic

Anthropic supports native structured outputs through `output_config.format`.

Expected mapping:

```ts
output_config: {
  format: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['name', 'email'],
      additionalProperties: false,
    },
  },
}
```

Anthropic also supports strict tool input schemas, but that is a separate
feature from structured final answers.

Important Anthropic behavior:

- Refusals may not match the schema.
- `max_tokens` can cut off JSON output.
- Grammar compilation and caching can add first-request latency.
- Schema complexity limits apply.

Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

## Proposed Public API

Add these types to `src/types.ts`:

```ts
export type StructuredOutputMode = 'json_object' | 'json_schema' | 'text';
export type StructuredOutputStatus =
  | 'disabled'
  | 'parsed'
  | 'parse_error'
  | 'refusal';

export interface JsonObjectResponseFormat {
  type: 'json_object';
  parse?: boolean;
}

export interface JsonSchemaResponseFormat {
  type: 'json_schema';
  name?: string;
  schema: CanonicalJsonSchema;
  strict?: boolean;
  parse?: boolean;
}

export type ResponseFormat =
  | { type: 'text' }
  | JsonObjectResponseFormat
  | JsonSchemaResponseFormat;
```

Add `responseFormat?: ResponseFormat` to:

- `LLMRequestOptions`
- `ConversationOptions`
- `ConversationSnapshot`
- `SessionConversationConfig`
- `SessionCreateRequest`
- `SessionMessageRequest`

Add optional response fields:

```ts
export interface CanonicalResponse {
  // existing fields remain unchanged
  parsed?: JsonValue;
  parseError?: string;
  refusal?: string;
  responseFormat?: StructuredOutputMode;
  structuredOutputStatus?: StructuredOutputStatus;
}
```

Compatibility rule: `text` remains the canonical returned string. `parsed` is
only populated when parsing succeeds and `responseFormat.parse !== false`.
Provider refusal signals must be preserved in `refusal` and
`structuredOutputStatus: 'refusal'` instead of being collapsed into a generic
parse failure.

## Schema Type Strategy

The existing `CanonicalToolSchema` is close to what is needed, but structured
outputs need a more general JSON Schema shape.

Add:

```ts
export interface CanonicalJsonSchema {
  $defs?: Record<string, CanonicalJsonSchema>;
  $ref?: string;
  additionalProperties?: boolean | CanonicalJsonSchema;
  anyOf?: CanonicalJsonSchema[];
  description?: string;
  enum?: readonly JsonPrimitive[];
  format?: string;
  items?: CanonicalJsonSchema;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  prefixItems?: CanonicalJsonSchema[];
  properties?: Record<string, CanonicalJsonSchema>;
  required?: readonly string[];
  title?: string;
  type?:
    | 'array'
    | 'boolean'
    | 'integer'
    | 'null'
    | 'number'
    | 'object'
    | 'string'
    | readonly (
        | 'array'
        | 'boolean'
        | 'integer'
        | 'null'
        | 'number'
        | 'object'
        | 'string'
      )[];
}
```

Do not remove or repurpose `CanonicalToolSchema` in the first release. Keep tool
schemas stable.

The public `CanonicalJsonSchema` type is intentionally broader than any one
provider's supported subset. The implementation must define exact behavior for
each included keyword before accepting it. Do not leave keyword handling to
provider error messages.

| Keyword | OpenAI | Gemini generateContent | Anthropic | First-release behavior |
| --- | --- | --- | --- | --- |
| `type` | Pass through | Pass through after provider casing/shape normalization if required | Pass through | Support |
| `properties` | Pass through | Pass through | Pass through | Support |
| `required` | Strict mode must require every declared object property, or reject before dispatch | Pass through | Pass through | Support with provider-specific validation |
| `items` | Pass through | Pass through | Pass through | Support |
| `enum` | Pass through | Pass through | Pass through | Support |
| `description` | Pass through | Pass through | Pass through | Support |
| `additionalProperties` | Strict mode must set every object schema to `false`, or reject before dispatch | Pass through when valid; reject or transform only if local raw-endpoint tests prove a limitation | Pass through or inject `false` only when required by provider behavior | Provider-specific helper test required |
| `$defs` / `$ref` | Supported within OpenAI's documented subset | Supported by Gemini docs | Reject unless verified | Product decision: reject in v1 for portability unless provider-specific mode is added |
| `anyOf` | Supported when each nested schema follows OpenAI's subset | Supported by Gemini docs | Reject unless verified | Product decision: reject in v1 for portability unless provider-specific mode is added |
| `minimum` / `maximum` | Supported by current OpenAI docs | Supported by current Gemini docs | Strip and append constraint text to `description` only if matching Anthropic documented transformation | Product decision: reject in v1 for portability unless provider-specific mode is added |
| `minLength` / `maxLength` | Reject or transform before dispatch; not listed in the current base OpenAI Structured Outputs subset | Not portable across all providers | Strip and append constraint text to `description` only if matching Anthropic documented transformation | Product decision: reject in v1 for portability unless provider-specific mode is added |
| `minItems` / `maxItems` | Supported by current OpenAI docs | Supported by current Gemini docs | Strip and append constraint text to `description` only if matching Anthropic documented transformation | Product decision: reject in v1 for portability unless provider-specific mode is added |
| `title` | Reject unless verified | Supported by current Gemini docs | Reject unless verified | Product decision: reject in v1 for portability unless provider-specific mode is added |
| `format` | Supported by current OpenAI docs where allowed | Supported by current Gemini docs | Reject unless verified | Product decision: reject in v1 for portability unless provider-specific mode is added |
| `prefixItems` | Reject unless verified | Supported by current Gemini docs | Reject unless verified | Product decision: reject in v1 for portability unless provider-specific mode is added |
| union `type` arrays | Supported by current OpenAI docs, especially nullable unions | Supported by Gemini docs for nullable unions | Reject unless verified | Product decision: reject in v1 for portability unless provider-specific mode is added |

Add helper tests for every keyword listed in `CanonicalJsonSchema`. Each test
must assert one of three outcomes for every provider: pass through, transform,
or reject with `ProviderCapabilityError` before the network call.

## Internal Helpers

Create `src/structured-output.ts`:

```ts
export function normalizeResponseFormatForProvider(
  responseFormat: ResponseFormat | undefined,
  provider: CanonicalProvider,
): ProviderResponseFormat | undefined;

export function parseStructuredOutput(
  response: CanonicalResponse,
  responseFormat: ResponseFormat | undefined,
): CanonicalResponse;
```

Provider-specific schema normalization should be conservative and explicit:

- OpenAI: pass through only documented Structured Outputs schema fields and
  require a deterministic `name` fallback for schema mode. For
  `strict: true`, normalize or reject before dispatch:
  - every object schema must include `additionalProperties: false`;
  - every declared property must be included in `required`;
  - unsupported keywords must be rejected or transformed before the network
    call, never left for OpenAI to reject.
- Gemini: normalize to the documented raw generateContent
  `generationConfig.responseFormat.text` shape and strip or reject unsupported
  fields before request translation.
- Anthropic: normalize to `output_config.format`, applying only documented
  transformations. If constraints are removed, append constraint information to
  `description` only when that transformation is covered by docs/tests.

Add tests for the normalization helpers so adapter tests do not duplicate every
schema edge case.

## Provider Implementation Plan

### OpenAI Adapter

Files:

- `src/providers/openai.ts`
- `test/openai.adapter.test.ts`

Implementation:

- Read `options.responseFormat`.
- For `json_object`, set:

```ts
body.text = { format: { type: 'json_object' } };
```

- Before dispatching OpenAI `json_object`, verify that at least one system,
  user, or assistant text segment contains the string `JSON`. OpenAI documents
  this as required and can otherwise error or produce whitespace until the token
  limit. For v1, reject locally with `ProviderCapabilityError` or `ProviderError`
  instead of auto-injecting instructions that might alter user prompts.

- For `json_schema`, set:

```ts
body.text = {
  format: {
    type: 'json_schema',
    name: responseFormat.name ?? 'structured_output',
    strict: responseFormat.strict ?? true,
    schema: normalizeOpenAISchema(responseFormat.schema),
  },
};
```

- Preserve existing `tools`, `tool_choice`, reasoning, and prompt caching behavior.
- Add response parsing after canonical response construction.

Tests:

- `json_object` maps to `text.format.type`.
- `json_object` with no `JSON` instruction in `system` or message text rejects
  before provider dispatch.
- `json_schema` maps to `text.format.type`, `name`, `schema`, and `strict`.
- With OpenAI `strict: true`, schemas missing `additionalProperties: false`
  on object nodes are fixed or rejected before dispatch.
- With OpenAI `strict: true`, object schemas with properties missing from
  `required` are fixed or rejected before dispatch.
- With OpenAI `strict: true`, unsupported schema keywords are rejected or
  transformed before dispatch.
- Existing tool request fixtures are unchanged.
- Refusal response remains representable and does not crash parsing.
- OpenAI refusal parts from `src/providers/openai.ts` are exposed as
  `response.refusal` and `structuredOutputStatus: 'refusal'`, not merely as
  plain text or `parseError`.

### Gemini Adapter

Files:

- `src/providers/gemini.ts`
- `test/gemini.adapter.test.ts`

Implementation:

- Add structured output fields into existing `generationConfig`.
- For `json_object`, set JSON MIME type without a schema:

```ts
generationConfig.responseFormat = {
  text: {
    mimeType: 'application/json',
  },
};
```

- For `json_schema`, set:

```ts
generationConfig.responseFormat = {
  text: {
    mimeType: 'application/json',
    schema: normalizeGeminiSchema(responseFormat.schema),
  },
};
```

- Reuse lessons from Gemini tool schemas: unsupported fields must be stripped or transformed before calling the API.
- Add a regression note: do not use `generationConfig.responseMimeType` /
  `responseSchema` for this library unless live REST verification confirms that
  shape is accepted by the endpoint used in `src/providers/gemini.ts`.

Tests:

- `json_object` sets `generationConfig.responseFormat.text.mimeType`.
- `json_schema` sets both `generationConfig.responseFormat.text.mimeType` and
  `generationConfig.responseFormat.text.schema`.
- Unsupported schema fields are stripped deterministically.
- Existing thinking, caching, tools, and tool-choice tests still pass.

### Anthropic Adapter

Files:

- `src/providers/anthropic.ts`
- `test/anthropic.adapter.test.ts`

Implementation:

- For `json_schema`, set:

```ts
body.output_config = {
  format: {
    type: 'json_schema',
    schema: normalizeAnthropicSchema(responseFormat.schema),
  },
};
```

- For `json_object`, v1 should throw `ProviderCapabilityError`. Anthropic
  documents `output_config.format` for `json_schema`, but does not document a
  separate JSON-object-only mode. Do not emulate this with
  `{ type: 'object', additionalProperties: true }` unless a live REST
  verification proves the request is accepted and product docs explicitly call
  it an Anthropic-specific emulation. Users who need Anthropic structured output
  should use `json_schema`.

Tests:

- `json_schema` maps to `output_config.format`.
- `json_object` throws `ProviderCapabilityError` for Anthropic before dispatch.
- Existing thinking, cache-control, tools, and streaming tests still pass.

## Parsing And Validation Behavior

Default behavior:

- Parse only when `responseFormat.type !== 'text'`.
- If parsing succeeds, set `response.parsed`.
- Provider translators must detect structured refusals before generic parsing:
  - OpenAI refusal parts are currently flattened into text in
    `src/providers/openai.ts`; this must change so the translator sets
    `response.refusal` and `structuredOutputStatus: 'refusal'` directly.
  - Anthropic local response payload types must include `stop_reason:
    'refusal'`; `normalizeAnthropicFinishReason()` must preserve refusal state
    for structured output handling instead of normalizing it to a generic stop.
  - Refusal detection runs before `parseStructuredOutput()`.
- If a provider returns a structured refusal, set `response.refusal` and
  `structuredOutputStatus: 'refusal'` and do not treat it as a parse error.
- If parsing fails:
  - Set `response.parseError`.
  - Set `structuredOutputStatus: 'parse_error'`.
  - Do not throw by default, because providers can return incomplete output on length cutoff.

Add an opt-in strict parse mode later if needed:

```ts
responseFormat: {
  type: 'json_schema',
  schema,
  parse: true,
  onParseError: 'throw',
}
```

Do not add schema validation in the first pass unless a small dependency-free
validator is already available. Provider-native schema adherence plus JSON.parse
is enough for the first release.

## Conversation And Session API Behavior

Conversation creation should persist `responseFormat` in snapshots so restored
conversations continue using the same structured output behavior.

Exact code paths to update:

- `src/client.ts:94` `LLMRequestOptions` is defined here, not in `src/types.ts`.
- `src/conversation.ts:70` `ConversationSnapshot` must persist `responseFormat`.
- `src/conversation.ts:254` conversation options/config construction must carry
  `responseFormat`.
- `src/conversation.ts:747` send/sendStream request construction must pass
  `responseFormat` into `LLMClient.complete()` and `LLMClient.stream()`.
- `src/session-api.ts:62` session API request/config types must include
  `responseFormat`.
- `src/session-api.ts:608` session config merge logic must preserve and
  validate `responseFormat`.

Session API should accept `responseFormat` in:

- session creation config
- per-message overrides, if other per-message generation options are accepted

Security considerations:

- Reject `responseFormat` objects that are too large.
- Reject schemas with extreme nesting depth.
- Reject schemas with too many properties.
- Do not execute or interpret schema descriptions.

Recommended limits:

- Max serialized schema size: 64 KB.
- Max schema depth: 20.
- Max object properties per object: 256.
- Max total schema nodes: 2,000.

## Streaming Behavior

Keep stream chunks unchanged for compatibility.

For structured output streams in v1:

- Continue emitting `text-delta`.
- Map `responseFormat` into provider request bodies so providers can constrain
  streamed text.
- Do not promise parsed stream output. The current public `StreamChunk` `done`
  variant in `src/types.ts` only exposes `{ finishReason, usage, type }`.
- Defer parsed streaming output to a separate public API decision. That later
  change must intentionally add something like `done.response` or
  `done.parsed` and document compatibility.

Do not emit partial parsed JSON in the first release.

## Model Capability Handling

Add structured-output capability metadata to model registry entries in the
first implementation. The existing registry already stores capability flags such
as `supportsTools` and `supportsStreaming`, so structured-output support should
follow the same pattern.

Use flat capability flags so existing `ModelRegistry.assertCapability()` can be
extended without a second nested capability mechanism:

```ts
supportsJsonObjectOutput?: boolean;
supportsJsonSchemaOutput?: boolean;
supportsStructuredOutputStreaming?: boolean;
```

Update `ModelCapability` in `src/types.ts` to include the new flat fields.

First release behavior:

- Populate metadata for built-in OpenAI, Gemini, and Anthropic models where the
  docs establish support.
- If a built-in model is known not to support the requested mode, throw
  `ProviderCapabilityError` before dispatch.
- Custom registered models may opt in by setting the same flat capability flags.
- Keep current registry behavior for unknown model strings: `resolveRequest()`
  calls `modelRegistry.get(model)` before dispatch, so unknown ad-hoc models
  continue to throw unless the caller registers them first.
- Provider adapters still perform final request-shape validation.

## Documentation Plan

Update:

- `README.md`
- `docs/COMPLETIONS_AND_STREAMING.md`
- `docs/PROVIDER_COMPARISON.md`
- `docs/CONVERSATIONS_AND_TOOLS.md`
- API docs via `pnpm docs:api`

Add examples:

- JSON object extraction.
- Strict JSON schema extraction.
- Tool calling vs structured final answer.
- Conversation with persistent `responseFormat`.
- Handling refusal / parse failure / length cutoff.

## Test Plan

Unit tests:

- `test/openai.adapter.test.ts`
- `test/gemini.adapter.test.ts`
- `test/anthropic.adapter.test.ts`
- `test/client.test.ts`
- `test/conversation.test.ts`
- `test/session-api.test.ts`
- `test/model-registry.test.ts`

Required negative/edge tests:

- Provider translators set refusal fields before generic parsing runs.
- Anthropic `stop_reason: 'refusal'` is represented in local payload types and
  mapped to `structuredOutputStatus: 'refusal'`.
- OpenAI refusal parts are not only flattened into normal text.
- `finishReason: 'length'` / Anthropic `max_tokens` with partial JSON returns
  `parseError` without throwing by default.
- Malformed JSON returns `parseError` without throwing by default.
- Streaming with `responseFormat` maps provider request fields, but does not
  expose parsed output in v1.
- Built-in model registry entries expose structured-output capability metadata.

Live tests:

- Add opt-in tests under `test/live-real`.
- Keep live tests out of normal CI.
- Include one low-cost JSON schema extraction test per provider.
- Mark provider account quota failures as environment issues in reports.

Quality gates:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm sizecheck
pnpm depcheck
pnpm edgecheck
pnpm docs:api
```

## Rollout Plan

### Phase 1: Types And Internal Normalization

- Add `ResponseFormat` and `CanonicalJsonSchema` types.
- Add `responseFormat?: ResponseFormat` to `src/client.ts` `LLMRequestOptions`;
  do not assume this request type lives in `src/types.ts`.
- Add schema size/depth validation.
- Add provider normalization helper.
- Add structured-output capability fields to model metadata and built-in
  registry entries.
- Add tests for helper behavior.

### Phase 2: Provider Mappings

- Implement OpenAI `text.format`.
- Implement Gemini `generationConfig.responseFormat.text.mimeType` / `schema`
  for the raw generateContent endpoint currently used by the library.
- Implement Anthropic `output_config.format`.
- Add adapter translation tests.
- Implement provider-level refusal detection before canonical parse handling.

### Phase 3: Canonical Response Parsing

- Add `parsed`, `parseError`, and `responseFormat` to `CanonicalResponse`.
- Add `refusal` and `structuredOutputStatus` to `CanonicalResponse`.
- Parse successful JSON text for `complete()`.
- Keep streaming parsed output out of v1; only provider request mapping is in
  scope for streams.

### Phase 4: Conversation And Session API

- Thread `responseFormat` through conversations.
- Persist it in `ConversationSnapshot`.
- Update conversation request assembly around `src/conversation.ts:254` and
  `src/conversation.ts:747`.
- Update Session API config typing and merge logic around `src/session-api.ts:62`
  and `src/session-api.ts:608`.
- Accept it in Session API configs with schema limits.
- Add compatibility tests for old snapshots without `responseFormat`.

### Phase 5: Docs And Live Tests

- Add user-facing docs and examples.
- Add opt-in live-real tests.
- Regenerate API docs.

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Existing users see changed response shape | Medium | Only add optional fields; keep `text` unchanged |
| Provider schema subsets differ | High | Normalize per provider and test each public keyword as pass through, transform, or reject |
| JSON mode hangs or whitespace output | Medium | Reject OpenAI `json_object` before dispatch unless context contains `JSON`; do not auto-inject in v1 |
| Refusals do not match schema | Medium | Preserve refusal text and expose `structuredOutputStatus: 'refusal'` |
| Truncated output breaks JSON parse | Medium | Do not throw by default; expose `parseError` |
| Large schemas cause provider failures | High | Add schema size/depth/node limits before provider call |
| Bundle size grows | Low | Avoid new runtime dependencies |
| Tool schemas and response schemas diverge | Medium | Keep separate types in first release; share helpers where safe |
| Unverified provider emulation creates false portability | Medium | Do not emulate Anthropic `json_object` in v1; require `json_schema` or live verification before adding emulation |
| Unsupported model receives native structured-output request | Medium | Add model registry capability metadata and pre-dispatch checks for built-in models |
| Streaming API accidentally promises parsed output | Medium | Scope v1 to request mapping only; parsed stream output requires a separate public chunk-shape decision |

## Recommended Acceptance Criteria

- Existing `pnpm test` passes without changing any test call sites.
- Existing public examples still compile.
- A call with no `responseFormat` produces byte-for-byte equivalent provider request bodies in adapter tests.
- OpenAI structured output request includes `text.format.type = 'json_schema'`.
- OpenAI `json_object` rejects before provider dispatch when no system/message
  text contains `JSON`.
- OpenAI strict schemas are normalized or rejected before dispatch when object
  schemas are missing `additionalProperties: false`.
- OpenAI strict schemas are normalized or rejected before dispatch when object
  schemas have declared properties missing from `required`.
- OpenAI strict schemas reject or transform unsupported keywords before
  dispatch instead of relying on provider-side errors.
- Gemini structured output request includes
  `generationConfig.responseFormat.text.mimeType = 'application/json'` and a
  schema under `generationConfig.responseFormat.text.schema` for schema mode.
- Anthropic structured output request includes `output_config.format.type = 'json_schema'`.
- Anthropic `json_object` rejects with `ProviderCapabilityError` before
  provider dispatch unless a future live verification explicitly changes this
  product decision.
- `response.parsed` is populated for valid JSON output.
- OpenAI refusal parts are exposed as `response.refusal` with
  `structuredOutputStatus: 'refusal'`.
- Anthropic `stop_reason: 'refusal'` is represented in local payload types and
  exposed as `response.refusal` with `structuredOutputStatus: 'refusal'`.
- Invalid or truncated JSON does not crash unless strict parse mode is explicitly enabled.
- Malformed JSON sets `parseError` without throwing by default.
- `finishReason: 'length'` and Anthropic `max_tokens` partial JSON set
  `parseError` without throwing by default.
- Streaming tests assert provider request mapping only; no v1 test should expect
  parsed data on `StreamChunk.done`.
- Built-in model registry entries include structured-output capability metadata
  for known supported OpenAI, Gemini, and Anthropic models.
- Built-in models known not to support a requested structured-output mode fail
  before provider dispatch.
- Helper tests cover every keyword included in `CanonicalJsonSchema` for each
  provider with explicit pass-through, transform, or reject behavior.
- Session API rejects oversized schemas.
- Docs explain when to use tools vs structured final answers.

## Recommendation

Implement this feature. It fits the library's purpose: users should not need to
learn three provider-specific structured-output APIs. The safest path is an
opt-in canonical `responseFormat` field, provider-native mapping, conservative
schema normalization, and additive response parsing.
