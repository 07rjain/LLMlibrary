# Prompt Caching Report

Prepared: `2026-04-21`

This report compares how prompt or context caching works for OpenAI, Anthropic, and Gemini, and maps that against the current implementation in this repository.

## Executive Summary

- OpenAI is the easiest provider to finish for request-side support. Prompt caching is automatic on supported models, and the main library work is exposing request knobs such as `prompt_cache_key` and `prompt_cache_retention`.
- Anthropic already has the closest adapter implementation in this repo, but it is incomplete. The code supports `cache_control` on text parts and cached system text, while Anthropic's API supports broader explicit caching and automatic caching semantics.
- Gemini is the largest gap. Implicit caching needs no request change, but explicit caching requires a separate cached-content resource lifecycle plus request-time `cachedContent` references.
- Cost accounting needs review before shipping this as a feature. OpenAI is likely double-counted today, and Gemini explicit caching cannot be modeled correctly from `generateContent` usage alone without also tracking cache-creation events.

## Current State In This Repo

### What already exists

- `src/types.ts` defines `CacheControl`, but only `TextPart` can carry `cacheControl`.
- `src/providers/anthropic.ts` already maps text-part and system-text `cacheControl` to Anthropic `cache_control`.
- `src/providers/openai.ts` already parses OpenAI cached-token usage from Responses fields and still accepts the legacy Chat Completions usage shape.
- `src/providers/gemini.ts` already parses `usageMetadata.cachedContentTokenCount`.
- `src/utils/cost.ts` already normalizes cached-token fields for all three providers.

### What is missing

- OpenAI request translation does not expose any prompt caching controls.
- Gemini request translation does not expose `cachedContent`.
- There is no cache lifecycle API for Gemini cached-content resources.
- Anthropic request support is text-only, even though the provider supports a broader set of cacheable content.
- `CanonicalTool` and most non-text parts cannot carry cache metadata today.

## OpenAI

### What the official docs say

- Prompt caching works automatically on supported recent models, including `gpt-4o` and newer, with no explicit opt-in required.
- Caching is available for prompts that are `1024` tokens or longer.
- OpenAI exposes `prompt_cache_key` to improve routing for requests with common prefixes.
- OpenAI exposes `prompt_cache_retention` on `Responses.create` and `chat.completions.create`.
- Allowed retention values are `in_memory` and `24h`; the default is `in_memory`.
- Cache-hit information for Responses is returned in `usage.input_tokens_details.cached_tokens`.
- OpenAI documents cacheable prefixes as including messages, images, tools, and structured-output schemas.

### What that means for this library

- The current OpenAI adapter already reads cache-hit usage, but it does not let callers influence caching behavior.
- This library already uses `/v1/responses` in stateless mode, so the missing work is request-surface support plus cost-accounting fixes rather than a transport migration.

### Recommended implementation

Add provider-specific OpenAI caching options to the request surface and pass them through in `translateOpenAIRequest`.

Suggested shape:

```ts
interface OpenAIPromptCachingOptions {
  key?: string;
  retention?: 'in_memory' | '24h';
}
```

Suggested mapping:

```ts
body.prompt_cache_key = options.openai?.promptCaching?.key;
body.prompt_cache_retention = options.openai?.promptCaching?.retention;
```

### Code areas to change

- `src/providers/openai.ts`
- `src/client.ts`
- whichever shared request type carries provider-specific options
- `test/openai.adapter.test.ts`

### Important accounting note

OpenAI returns `cached_tokens` inside the input-usage details. That strongly suggests cached tokens are a subset of total input tokens, not an extra bucket. Based on that, the current cost logic is likely overstating OpenAI request cost by charging:

- full `input_tokens` at normal input price
- plus `cached_tokens` again at cache-read price

This is an inference from OpenAI's usage shape and should be verified against real billing data, but it is the correct implementation direction unless OpenAI documents otherwise.

## Anthropic

### What the official docs say

- Prompt caching is supported on all active Claude models.
- Anthropic supports both automatic caching and explicit block-level cache breakpoints.
- Requests can carry top-level `cache_control`, and content blocks can also carry `cache_control`.
- Anthropic supports up to `4` cache breakpoints.
- Anthropic supports `5-minute` and `1-hour` TTLs.
- Anthropic documents cacheable content including tool definitions, system blocks, message content, and tool-use or tool-result flows.
- Anthropic returns separate usage buckets: `cache_read_input_tokens`, `cache_creation_input_tokens`, and `input_tokens`.

### What that means for this library

- This repo already implements the most important Anthropic primitive: `cache_control` on text blocks.
- The current implementation is still narrower than the provider surface because only `TextPart` can carry `cacheControl`.
- Tool definitions are not cache-aware in the canonical model today.
- The request surface does not currently expose Anthropic's broader automatic caching controls directly.

### Recommended implementation

Finish Anthropic support in two layers:

1. Broaden cache annotations on cacheable content.
2. Expose request-level Anthropic caching options.

Suggested directions:

- Move `cacheControl?: CacheControl` from `TextPart` into a reusable base interface shared by:
  - `TextPart`
  - `ImageUrlPart`
  - `ImageBase64Part`
  - `DocumentPart`
  - `CanonicalToolCallPart`
  - `CanonicalToolResultPart`
- Add Anthropic cache metadata for tool definitions.
- Add request-level Anthropic options such as top-level `cache_control`.

### Code areas to change

- `src/types.ts`
- `src/providers/anthropic.ts`
- `test/anthropic.adapter.test.ts`

### Cost/accounting status

Anthropic is the cleanest provider for current cost math because the API already separates uncached input, cache reads, and cache writes into distinct usage fields. The existing normalization in `src/utils/cost.ts` is aligned with the docs.

## Gemini

### What the official docs say

- Gemini has two different mechanisms: implicit caching and explicit caching.
- Implicit caching is enabled by default for Gemini `2.5` and newer models, and Google automatically passes through savings on cache hits.
- Gemini documents model-specific minimum token thresholds for implicit caching.
- Explicit caching uses separate cached-content resources that are created first and then referenced from later generation requests.
- Explicit caching supports TTL, and the guide states the default TTL is `1 hour` when not set.
- `GenerateContent` requests can reference cached content via `cachedContent` in the API or `cached_content` in SDK examples.
- Gemini returns `cachedContentTokenCount` in usage metadata.
- Gemini exposes separate cache-resource APIs such as `cachedContents.create`, and the guide also documents listing cache metadata.

### What that means for this library

- Implicit caching requires no request changes, but it should be documented because users will benefit automatically.
- Explicit caching cannot be implemented properly as a single boolean option on `complete()`.
- The library needs two separate capabilities: use an existing cache in a generation request, and manage Gemini cache resources.

### Recommended implementation

Implement Gemini in phases.

Phase 1:

- Add request support for using an existing cache:

```ts
interface GeminiPromptCachingOptions {
  cachedContent?: string;
}
```

- Map that to the request body:

```ts
body.cachedContent = options.google?.promptCaching?.cachedContent;
```

Phase 2:

- Add a small cache management API for Gemini:
  - `createCache`
  - `getCache`
  - `listCaches`
  - `updateCache`
  - `deleteCache`

This could sit under a provider-specific helper such as:

```ts
client.googleCaches.create(...)
```

or:

```ts
client.providers.google.caches.create(...)
```

### Code areas to change

- `src/providers/gemini.ts`
- `src/client.ts`
- new provider-specific cache client module for Gemini
- `test/gemini.adapter.test.ts`
- new tests for cache lifecycle methods

### Important accounting note

Gemini explicitly states that `promptTokenCount` still includes cached content when `cachedContent` is used. The current `geminiUsageToCanonical()` implementation stores `cachedContentTokenCount`, but cost calculation still treats all prompt tokens as normal input tokens. That means cached-read discounts are not modeled today.

There is a second issue for explicit Gemini caching: cache creation and TTL-related persistence costs do not come from the `GenerateContent` response alone. If the library wants accurate Gemini cache economics, it needs either:

- cache-creation usage events, or
- a documented limitation that per-request usage cost excludes cache creation and persistence cost

## Design Recommendation

Do not force one artificial cross-provider caching abstraction across all three providers.

The APIs are structurally different:

- OpenAI: automatic prefix caching plus request hints
- Anthropic: automatic caching plus explicit block-level cache control
- Gemini: automatic implicit caching plus separate cached-content resources

The cleanest design is:

- keep shared usage reporting in the canonical response
- add provider-specific request options for caching
- add provider-specific cache management only where the provider actually exposes resource lifecycles

Suggested direction:

```ts
interface ProviderOptions {
  anthropic?: {
    cacheControl?: CacheControl;
  };
  openai?: {
    promptCaching?: {
      key?: string;
      retention?: 'in_memory' | '24h';
    };
  };
  google?: {
    promptCaching?: {
      cachedContent?: string;
    };
  };
}
```

## Recommended Delivery Order

1. Fix cached-token accounting for OpenAI and Gemini.
2. Add OpenAI request-side prompt caching options.
3. Finish Anthropic cache metadata support beyond text parts.
4. Add Gemini request-side `cachedContent` support.
5. Add Gemini cache lifecycle APIs.
6. Add docs and examples for each provider.

## Test Plan

- OpenAI adapter test for `prompt_cache_key`
- OpenAI adapter test for `prompt_cache_retention`
- OpenAI usage-cost test that avoids double-counting cached tokens
- Anthropic adapter tests for non-text cacheable blocks where supported
- Anthropic adapter test for request-level `cache_control`
- Gemini adapter test for `cachedContent`
- Gemini usage-cost test for cached prompt tokens
- Gemini cache lifecycle tests for create, get, list, update, delete

## Effort Estimate

- OpenAI request support: low
- Anthropic completion of cache controls: medium
- Gemini explicit caching support: high
- Correct cross-provider cost accounting: medium

## Source Links

- OpenAI prompt caching guide: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI model comparison and pricing: https://developers.openai.com/api/docs/models/compare
- Anthropic prompt caching guide: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Gemini context caching guide: https://ai.google.dev/gemini-api/docs/caching/
- Gemini generate-content reference: https://ai.google.dev/api/generate-content
- Gemini caching API reference: https://ai.google.dev/api/caching
