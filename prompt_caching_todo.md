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
- [ ] OpenAI request-side prompt caching controls are not exposed yet
- [ ] OpenAI cached-token cost accounting likely still double-counts cached reads
- [ ] Anthropic cache metadata is still too narrow in the canonical type system
- [ ] Gemini request-side `cachedContent` support is not exposed yet
- [ ] Gemini cache lifecycle APIs do not exist yet

## Design Constraints

- Do not move conversation state into provider-managed storage.
- Do not force one shared caching API that hides provider differences.
- Keep provider-specific options additive so existing callers do not break.
- Treat cost-accounting changes as part of the feature, not as optional cleanup.

## Phase 1 - Request Surface And Cost Accounting

### PC-01 Provider-specific caching option carrier
Priority: `P0`

- [ ] Decide the shared request-type location for provider-specific caching options
- [ ] Add types for:
  - [ ] `openai.promptCaching.key`
  - [ ] `openai.promptCaching.retention`
  - [ ] `anthropic.cacheControl`
  - [ ] `google.promptCaching.cachedContent`
- [ ] Thread the new provider-specific options through `LLMClient.complete()`, `stream()`, and conversation entry points

### PC-02 OpenAI cached-token accounting
Priority: `P0`

- [ ] Confirm the current OpenAI cost math does not bill cached tokens twice
- [ ] Adjust cost calculation so cached OpenAI input tokens are not charged once at full input price and again at cache-read price
- [ ] Add unit coverage for OpenAI cached-token billing scenarios
- [ ] Document any assumptions that still depend on live billing validation

### PC-03 Gemini cached-token accounting limits
Priority: `P0`

- [ ] Decide how to represent Gemini cached-read discounts in current per-request usage cost
- [ ] Document the limit that explicit Gemini cache creation/persistence cost is not available from `GenerateContent` responses alone
- [ ] Add tests that lock the chosen behavior

## Phase 2 - OpenAI Prompt Caching

### PC-04 OpenAI request mapping
Priority: `P0`

- [ ] Add OpenAI prompt caching options to the public request surface
- [ ] Map `openai.promptCaching.key` to `prompt_cache_key`
- [ ] Map `openai.promptCaching.retention` to `prompt_cache_retention`
- [ ] Keep the current stateless Responses request shape with `store: false`

### PC-05 OpenAI verification
Priority: `P0`

- [ ] Add adapter tests for `prompt_cache_key`
- [ ] Add adapter tests for `prompt_cache_retention`
- [ ] Add client-level tests that provider-specific options survive routing
- [ ] Add documentation/examples for OpenAI prompt caching usage

## Phase 3 - Anthropic Prompt Caching

### PC-06 Broaden cache metadata in canonical types
Priority: `P1`

- [ ] Move `cacheControl` from text-only placement into a reusable cacheable-part base type
- [ ] Extend cache metadata support to:
  - [ ] image parts
  - [ ] document parts
  - [ ] tool-call parts where valid
  - [ ] tool-result parts where valid
- [ ] Decide whether `CanonicalTool` should also support Anthropic-specific cache metadata

### PC-07 Anthropic adapter expansion
Priority: `P1`

- [ ] Map broader cacheable canonical parts into Anthropic `cache_control`
- [ ] Add request-level Anthropic caching options where useful
- [ ] Add tests for non-text cacheable blocks
- [ ] Add tests for request-level Anthropic cache controls
- [ ] Document Anthropic-specific cache semantics and limits

## Phase 4 - Gemini Prompt Caching

### PC-08 Request-side `cachedContent`
Priority: `P1`

- [ ] Add Gemini prompt caching request options to the public request surface
- [ ] Map `google.promptCaching.cachedContent` to the Gemini request body
- [ ] Add adapter tests for `cachedContent`
- [ ] Add examples that separate implicit and explicit caching

### PC-09 Gemini cache lifecycle API
Priority: `P1`

- [ ] Choose the public API shape for Gemini cache management
- [ ] Implement:
  - [ ] `createCache`
  - [ ] `getCache`
  - [ ] `listCaches`
  - [ ] `updateCache`
  - [ ] `deleteCache`
- [ ] Add tests for cache lifecycle methods
- [ ] Document TTL expectations, identifiers, and usage boundaries

## Phase 5 - Docs, Examples, And Validation

### PC-10 Documentation
Priority: `P0`

- [x] Update README and docs to reflect the current OpenAI Responses transport
- [x] Update the prompt caching report so it matches the current codebase
- [ ] Add user-facing examples for OpenAI, Anthropic, and Gemini caching
- [ ] Update provider comparison docs after request-side caching features ship

### PC-11 Validation
Priority: `P1`

- [ ] Run live validation with real provider keys after each provider slice lands
- [ ] Compare cached-token usage outputs against provider dashboards/billing where possible
- [ ] Record known accuracy limits for cache-related cost reporting

## Recommended Delivery Order

1. [ ] PC-01 provider-specific option carrier
2. [ ] PC-02 OpenAI cached-token cost fix
3. [ ] PC-04 and PC-05 OpenAI request-side prompt caching support
4. [ ] PC-06 and PC-07 Anthropic cache metadata expansion
5. [ ] PC-03 Gemini cached-token accounting decision
6. [ ] PC-08 Gemini request-side `cachedContent`
7. [ ] PC-09 Gemini cache lifecycle API
8. [ ] PC-10 and PC-11 docs/examples/live validation

## Open Questions

- [ ] Should `CanonicalTool` carry cache metadata, or should that stay provider-specific?
- [ ] Should provider-specific caching options live directly on completion params or inside a dedicated `providerOptions` object?
- [ ] How should Gemini cache creation costs be surfaced if the provider does not return them on normal generation requests?
- [ ] Do we want live smoke tests for cache behavior behind a separate opt-in flag in addition to `LIVE_TESTS=1`?
