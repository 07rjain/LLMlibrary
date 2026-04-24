# Prompt Caching Report

Prepared: `2026-04-25`

This report documents the prompt-caching surface that is currently shipped in `unified-llm-client`.

## Executive Summary

- Prompt caching is implemented today across OpenAI, Anthropic, and Gemini.
- The library intentionally exposes provider-specific caching controls rather than inventing one artificial cross-provider abstraction.
- OpenAI uses request-side prompt-caching hints on the Responses API.
- Anthropic supports cache control at the request, content-part, and tool-definition levels.
- Gemini supports cached generation reuse through `cachedContent` and also exposes explicit cache lifecycle methods through `client.googleCaches`.
- Usage normalization and cost estimation now account for cached-read and cached-write token paths where the provider returns them.

## Current Public Surface

The shipped public API is:

- `providerOptions.openai.promptCaching`
- `providerOptions.anthropic.cacheControl`
- part-level `cacheControl` on Anthropic-compatible content blocks
- tool-level `cacheControl` on Anthropic tool definitions
- `providerOptions.google.promptCaching.cachedContent`
- `client.googleCaches.create()`
- `client.googleCaches.get()`
- `client.googleCaches.list()`
- `client.googleCaches.update()`
- `client.googleCaches.delete()`

The library does not currently ship:

- one cross-provider `cache: true` style abstraction
- automatic cache-policy selection
- provider-dashboard reconciliation for cache storage charges

## Provider Behavior

### OpenAI

OpenAI requests now go through the Responses API and can include request-side caching hints.

Current mapping:

- `providerOptions.openai.promptCaching.key`
  - sent as `prompt_cache_key`
- `providerOptions.openai.promptCaching.retention`
  - sent as `prompt_cache_retention`

The OpenAI request translator also always sends `store: false`, because the library keeps conversation history in its own state layer.

Important note:

- OpenAI caching is still provider-controlled.
- These request fields are hints and identifiers, not a guarantee that a given request will hit cache.

## Anthropic

Anthropic caching is exposed in three places:

- request-level `providerOptions.anthropic.cacheControl`
- content-part-level `cacheControl`
- tool-definition-level `cacheControl`

Current request mapping:

- top-level request cache control is translated to `cache_control`
- content parts that carry `cacheControl` are translated to Anthropic content blocks with `cache_control`
- tools with `cacheControl` are translated to Anthropic tool definitions with `cache_control`

This means callers can choose coarse request-level caching or more selective block-level caching, depending on how they structure their prompt.

## Gemini

Gemini caching is split between implicit provider behavior and explicit cache resources.

Generation-time reuse:

- `providerOptions.google.promptCaching.cachedContent`
  - sent as `cachedContent`

Explicit cache lifecycle:

- `client.googleCaches.create()`
- `client.googleCaches.get()`
- `client.googleCaches.list()`
- `client.googleCaches.update()`
- `client.googleCaches.delete()`

The cache helpers normalize library model ids such as `gemini-2.5-flash` to the provider shape required by the Gemini cache API and return cache names in the provider format `cachedContents/{id}`.

## Usage And Cost Semantics

Caching support is not only a request-translation feature. The usage and cost pipeline also understands cached token paths.

Current normalization behavior:

- OpenAI:
  - maps `input_tokens_details.cached_tokens` and legacy `prompt_tokens_details.cached_tokens`
  - computes `billedInputTokens = inputTokens - cachedReadTokens`
- Anthropic:
  - maps `cache_read_input_tokens` to `cachedReadTokens`
  - maps `cache_creation_input_tokens` to `cachedWriteTokens`
- Gemini:
  - maps `cachedContentTokenCount` to `cachedReadTokens`
  - computes `billedInputTokens = promptTokenCount - cachedContentTokenCount`

Current cost behavior:

- cached-read tokens are billed separately when a model has `cacheReadPrice`
- cached-write tokens are billed separately when a model has `cacheWritePrice`
- if a model does not have explicit cache prices, the library falls back to derived estimates from `inputPrice`

Important limitation:

- Gemini cache creation and storage costs are not included in per-request generation cost.
- Those costs belong to cache lifecycle operations, not to the later generation request that reuses the cache.

## Testing Status

Prompt caching is covered at three levels:

- translator and unit coverage in adapter tests
- client routing coverage through `client.complete()` / `client.stream()`
- live cross-provider validation in the prompt-caching live suites

Relevant test areas include:

- OpenAI request-side cache fields
- Anthropic request-level, block-level, and tool-level cache control
- Gemini `cachedContent` request mapping
- Gemini cache lifecycle CRUD
- usage and cost normalization for cached tokens

## Current Gaps

The main remaining gaps are product and ergonomics questions, not missing core wiring:

- whether to add a `JsonFileKnowledgeStore`-style local cache metadata helper for app-layer experiments
- whether to expose a more opinionated helper around Anthropic cacheable system prefixes
- whether Gemini cache create/storage pricing should be surfaced as a separate reporting category
- whether the library should eventually offer an optional higher-level cache policy helper without hiding provider differences

## Recommendation

Keep the current provider-specific design.

That design matches the real provider differences:

- OpenAI uses request-side cache identifiers and retention hints
- Anthropic uses explicit `cache_control` at multiple prompt boundaries
- Gemini uses explicit reusable cache resources plus `cachedContent`

Trying to collapse these into one generic boolean would make the public surface simpler to read but less accurate to operate.

## Source Links

- OpenAI prompt caching guide: https://platform.openai.com/docs/guides/prompt-caching
- OpenAI Responses API reference: https://developers.openai.com/api/reference/responses
- Anthropic prompt caching guide: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Gemini caching guide: https://ai.google.dev/gemini-api/docs/caching
