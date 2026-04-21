# Prompt Caching TODO

Prepared: `2026-04-21`  
Source of truth: [docs/PROMPT_CACHING_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PROMPT_CACHING_REPORT.md)

## Goal

Ship provider-appropriate prompt caching support without forcing one artificial cross-provider abstraction.

Planned direction:

- keep shared cached-token reporting in canonical usage metrics
- add provider-specific request options for caching controls
- add provider-specific cache-management APIs only where the provider exposes real cache resources

## Current Status

- [x] OpenAI transport already uses stateless `POST /v1/responses`
- [x] OpenAI usage normalization already accepts Responses cached-token fields and legacy Chat Completions cached-token fields
- [x] Anthropic already supports `cache_control` on text parts and system text
- [x] Gemini usage normalization already reads `cachedContentTokenCount`
- [x] Prompt caching research is documented in [docs/PROMPT_CACHING_REPORT.md](/Users/rishabh/Desktop/tryandtested/chatbot101/docs/PROMPT_CACHING_REPORT.md)
- [x] OpenAI request-side prompt caching controls are exposed via `providerOptions.openai.promptCaching`
- [x] OpenAI cached-token cost accounting no longer double-counts cached reads
- [x] Gemini request-side `cachedContent` support is exposed via `providerOptions.google.promptCaching.cachedContent`
- [x] Anthropic top-level request `cache_control` can be passed via `providerOptions.anthropic.cacheControl`
- [x] Anthropic cache metadata now covers text, image, document, tool-call, tool-result, and tool-definition cache controls
- [x] Gemini cache lifecycle APIs exist through `client.googleCaches`
- [x] Dedicated cross-provider live prompt caching tests exist under `test/prompt_caching_test`

## Design Constraints

- Do not move conversation state into provider-managed storage.
- Do not force one shared caching API that hides provider differences.
- Keep provider-specific options additive so existing callers do not break.
- Treat cost-accounting changes as part of the feature, not as optional cleanup.

## Phase 1 - Request Surface And Cost Accounting

### PC-01 Provider-specific caching option carrier
Priority: `P0`

- [x] Decide the shared request-type location for provider-specific caching options
- [x] Add types for:
  - [x] `openai.promptCaching.key`
  - [x] `openai.promptCaching.retention`
  - [x] `anthropic.cacheControl`
  - [x] `google.promptCaching.cachedContent`
- [x] Thread the new provider-specific options through `LLMClient.complete()`, `stream()`, and conversation entry points

### PC-02 OpenAI cached-token accounting
Priority: `P0`

- [x] Confirm the current OpenAI cost math does not bill cached tokens twice
- [x] Adjust cost calculation so cached OpenAI input tokens are not charged once at full input price and again at cache-read price
- [x] Add unit coverage for OpenAI cached-token billing scenarios
- [x] Document any assumptions that still depend on live billing validation

Current implementation note:

- OpenAI cost accounting now treats cached reads as a subset of total input tokens by billing `inputTokens - cachedReadTokens` at normal input price plus `cachedReadTokens` at cache-read price. Live billing validation is still pending.

### PC-03 Gemini cached-token accounting limits
Priority: `P0`

- [x] Decide how to represent Gemini cached-read discounts in current per-request usage cost
- [x] Document the limit that explicit Gemini cache creation/persistence cost is not available from `GenerateContent` responses alone
- [x] Add tests that lock the chosen behavior

Current implementation note:

- Gemini cost accounting now treats `cachedContentTokenCount` as cached-read usage by billing `promptTokenCount - cachedContentTokenCount` at normal input price plus `cachedContentTokenCount` at cache-read price.
- Explicit cache creation and persistence cost are still not included in per-request generation cost because Gemini does not return those costs on normal `generateContent` responses.

## Phase 2 - OpenAI Prompt Caching

### PC-04 OpenAI request mapping
Priority: `P0`

- [x] Add OpenAI prompt caching options to the public request surface
- [x] Map `openai.promptCaching.key` to `prompt_cache_key`
- [x] Map `openai.promptCaching.retention` to `prompt_cache_retention`
- [x] Keep the current stateless Responses request shape with `store: false`

### PC-05 OpenAI verification
Priority: `P0`

- [x] Add adapter tests for `prompt_cache_key`
- [x] Add adapter tests for `prompt_cache_retention`
- [x] Add client-level tests that provider-specific options survive routing
- [x] Add documentation/examples for OpenAI prompt caching usage

## Phase 3 - Anthropic Prompt Caching

### PC-06 Broaden cache metadata in canonical types
Priority: `P1`

- [x] Move `cacheControl` from text-only placement into a reusable cacheable-part base type
- [x] Extend cache metadata support to:
  - [x] image parts
  - [x] document parts
  - [x] tool-call parts where valid
  - [x] tool-result parts where valid
- [x] Decide whether `CanonicalTool` should also support Anthropic-specific cache metadata

### PC-07 Anthropic adapter expansion
Priority: `P1`

- [x] Map broader cacheable canonical parts into Anthropic `cache_control`
- [x] Add request-level Anthropic caching options where useful
- [x] Add tests for non-text cacheable blocks
- [x] Add tests for request-level Anthropic cache controls
- [x] Document Anthropic-specific cache semantics and limits

## Phase 4 - Gemini Prompt Caching

### PC-08 Request-side `cachedContent`
Priority: `P1`

- [x] Add Gemini prompt caching request options to the public request surface
- [x] Map `google.promptCaching.cachedContent` to the Gemini request body
- [x] Add adapter tests for `cachedContent`
- [x] Add examples that separate implicit and explicit caching

### PC-09 Gemini cache lifecycle API
Priority: `P1`

- [x] Choose the public API shape for Gemini cache management
- [x] Implement:
  - [x] `createCache`
  - [x] `getCache`
  - [x] `listCaches`
  - [x] `updateCache`
  - [x] `deleteCache`
- [x] Add tests for cache lifecycle methods
- [x] Document TTL expectations, identifiers, and usage boundaries

## Phase 5 - Docs, Examples, And Validation

### PC-10 Documentation
Priority: `P0`

- [x] Update README and docs to reflect the current OpenAI Responses transport
- [x] Update the prompt caching report so it matches the current codebase
- [x] Add user-facing examples for OpenAI, Anthropic, and Gemini caching
- [x] Update provider comparison docs after request-side caching features ship

### PC-11 Validation
Priority: `P1`

- [x] Run live validation with real provider keys after each provider slice lands
- [ ] Compare cached-token usage outputs against provider dashboards/billing where possible
- [x] Record known accuracy limits for cache-related cost reporting

Current validation note:

- `LIVE_TESTS=1 pnpm test:live` now covers OpenAI request-side prompt caching hints, Anthropic cache-control requests, Gemini explicit cache lifecycle and reuse, and the Postgres-backed persistence path.
- `pnpm test:prompt-caching:live` now runs the dedicated cache-validation suite under `test/prompt_caching_test`, including automatic loading of `test/prompt_caching_test/.env`.
- Dashboard and invoice comparison still requires manual access outside this repository.

## Recommended Delivery Order

1. [x] PC-01 provider-specific option carrier
2. [x] PC-02 OpenAI cached-token cost fix
3. [x] PC-04 and PC-05 OpenAI request-side prompt caching support
4. [x] PC-06 and PC-07 Anthropic cache metadata expansion
5. [x] PC-03 Gemini cached-token accounting decision
6. [x] PC-08 Gemini request-side `cachedContent`
7. [x] PC-09 Gemini cache lifecycle API
8. [ ] PC-11 dashboard comparison and ongoing billing validation

## Open Questions

- [x] `CanonicalTool` now carries cache metadata for Anthropic tool-definition caching.
- [x] Provider-specific caching options now live inside the dedicated `providerOptions` object.
- [ ] How should Gemini cache creation costs be surfaced if the provider does not return them on normal generation requests?
- [x] Cache-related live smoke tests now run under the existing `LIVE_TESTS=1` gate.
- [x] A focused prompt-caching live runner now exists for cross-provider validation.
