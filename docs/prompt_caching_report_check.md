# Code Review: `prompt_caching` Branch

**Repo:** `unified-llm-client` (https://github.com/07rjain/LLMlibrary)
**Branch:** `prompt_caching` vs `main`
**Date:** April 2026

---

## Verdict: Needs Changes

The structural groundwork is solid — the right files were touched, the Gemini cache manager is well-designed, and the usage metric mapping in `cost.ts` is correct. However, two provider-level bugs mean the Anthropic and OpenAI caching paths do not actually work as implemented. The unified `cacheSystemPrompt` convenience option is also missing, and there are no tests for any of the new code paths.

---

## Critical Bugs

### 🔴 Bug 1 — Anthropic: `cache_control` placed at wrong level

**In `anthropic.ts`, `translateAnthropicRequest()`:**

The current implementation adds cache control at the top level of the request body:
```ts
if (options.providerOptions?.anthropic?.cacheControl) {
  body.cache_control = cacheControl;  // ❌ WRONG — no such field on the request body
}
```

The Anthropic API has no `cache_control` field on the request body. `cache_control` must be placed on **individual content blocks** — specifically on the last text block of the system prompt (or messages/tools you want cached).

**What it should look like:**
```ts
// When cacheSystemPrompt is true, inject cache_control on the system prompt block
if (options.cacheSystemPrompt && body.system) {
  const parts = Array.isArray(body.system) ? body.system : [{ type: 'text', text: body.system }];
  // Place cache_control on the LAST block (everything up to and including it gets cached)
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } };
  body.system = parts;
}
```

**Impact:** Anyone using `providerOptions.anthropic.cacheControl` gets full-price uncached requests with no error. The cache_control field is silently ignored by the API.

---

### 🔴 Bug 2 — OpenAI: Sending phantom fields that don't exist in the API

**In `openai.ts`, `translateOpenAIRequest()`:**

```ts
if (options.providerOptions?.openai?.promptCacheKey) {
  body.prompt_cache_key = options.providerOptions.openai.promptCacheKey;   // ❌ doesn't exist
  body.prompt_cache_retention = options.providerOptions.openai.cacheRetention; // ❌ doesn't exist
}
```

Neither `prompt_cache_key` nor `prompt_cache_retention` exist in the OpenAI Chat Completions or Responses API spec. **OpenAI prompt caching is fully automatic** — no request parameters are needed or accepted. The API caches prompts over 1,024 tokens server-side without any opt-in.

These fields will either be silently ignored (best case) or cause a `400` error on some model versions.

**What should happen instead:** Remove these fields entirely. OpenAI caching requires zero changes to the request. The only work needed is reading `usage.prompt_tokens_details.cached_tokens` from the response — which `cost.ts` already does correctly.

---

## Missing Features

### 🟡 Missing: `cacheSystemPrompt: boolean` on `LLMRequestOptions`

The unified `cacheSystemPrompt` convenience option was the agreed abstraction for the top-level interface. It was never added to `LLMRequestOptions` in `types.ts`.

Without it, the only way to enable Anthropic caching is via the lower-level `providerOptions.anthropic.cacheControl` path — which is both broken (see Bug 1) and provider-specific (defeats the purpose of a unified client).

**What to add in `types.ts`:**
```ts
export interface LLMRequestOptions {
  // ... existing fields ...
  cacheSystemPrompt?: boolean;  // Inject cache_control on system prompt (Anthropic); no-op for OpenAI/Gemini (automatic)
}
```

Then each adapter checks `options.cacheSystemPrompt`:
- **Anthropic** — injects `cache_control: { type: 'ephemeral' }` on the last system prompt block
- **OpenAI** — no-op (caching is automatic)
- **Gemini** — no-op for implicit caching (Gemini 2.5+ handles it automatically)

---

### 🟡 Missing: Tests

There is no test coverage for any of the new caching code paths. Given that caching bugs are silent (wrong requests succeed but aren't cached), tests are especially important here.

Tests needed:
- `anthropic.ts`: assert `cache_control` appears on system prompt content block when `cacheSystemPrompt: true`
- `anthropic.ts`: assert `cache_control` does NOT appear when `cacheSystemPrompt: false` or unset
- `openai.ts`: assert `prompt_cache_key` and `prompt_cache_retention` are NOT sent in any request
- `cost.ts`: assert `cachedTokens` is populated correctly from all three providers' response shapes
- `GeminiCacheManager`: basic lifecycle tests (create, get, delete)

---

## What's Correct ✅

### Gemini explicit cache management

The `GeminiCacheManager` class is well-implemented. Keeping it as a separate utility (not buried inside `complete()`) is exactly right — Gemini's explicit caching requires its own lifecycle (create → use → refresh → delete), and hiding it inside a completion call would be the wrong abstraction. The `createCache`, `getCache`, `listCaches`, `updateCache`, and `deleteCache` methods map correctly to the Gemini `cachedContents` API.

One minor note: add TTL validation — Gemini has a minimum cache size requirement (32,768 tokens for most models). A helpful error message when content is too small would save debugging time.

### `cost.ts` usage metric mapping

The `cachedTokens` mapping in the usage translation functions is correct for all three providers:

- **Anthropic** → `usage.cache_read_input_tokens` ✅
- **OpenAI** → `usage.prompt_tokens_details?.cached_tokens` ✅  
- **Gemini** → `usageMetadata.cachedContentTokenCount` ✅

This is the part of the feature that works correctly end-to-end.

### Per-block `cache_control` passthrough in `anthropic.ts`

The code that preserves `cache_control` on individual `CanonicalPart` items when translating to Anthropic format is structurally correct. This allows advanced users to manually mark specific message blocks for caching. The `cacheSystemPrompt` convenience option should build on top of this — it doesn't need to replace it.

---

## Minor Issues

### 🔵 Anthropic: Cache write tokens not mapped

Anthropic reports both cache read and cache write tokens separately:
- `usage.cache_read_input_tokens` — tokens served from cache (cheap)
- `usage.cache_creation_input_tokens` — tokens written to cache (expensive — ~25% more than normal)

The current `cost.ts` only maps `cache_read_input_tokens` to `cachedTokens`. Consider adding a `cacheWriteTokens` field to `UsageMetrics` so billing can account for the write cost. At minimum, include write tokens in the cost calculation.

### 🔵 `cacheSystemPrompt` placement in the system prompt

When implementing the Anthropic `cacheSystemPrompt` option, the cache_control marker position matters a lot. It must be placed at the **end of the static portion** of the system prompt, before any dynamic content (tenant-specific data, schema context, user info).

For the chatbot widget, the system prompt structure is:
```
[Static: bot personality + instructions]  ← cache_control goes HERE
[Dynamic: schema context (changes per tenant)]
[Dynamic: user context]
```

Placing the marker on the very last block works when the entire system prompt is static. If the system prompt has dynamic sections, the marker must be placed strategically. Document this behaviour clearly.

### 🔵 No `cacheSystemPrompt` in `ConversationConfig`

The `Conversation` class accepts a config at creation time that includes the system prompt and model settings. `cacheSystemPrompt` should also be available in `ConversationConfig` so it can be set once per conversation rather than on every `send()` call.

---

## Summary

| Area | Status | Notes |
|---|---|---|
| Anthropic cache_control on content blocks | ✅ Structurally correct | Needs `cacheSystemPrompt` wrapper |
| Anthropic top-level cache_control on request | 🔴 Bug | Must be removed — field doesn't exist |
| OpenAI phantom fields | 🔴 Bug | `prompt_cache_key` / `prompt_cache_retention` don't exist, must be removed |
| OpenAI automatic caching | ✅ Already works | No request changes needed |
| Gemini implicit caching | ✅ Works automatically | No changes needed |
| Gemini explicit cache manager | ✅ Well implemented | Add min-token validation |
| `cacheSystemPrompt` on `LLMRequestOptions` | 🟡 Missing | Add to `types.ts` and wire into Anthropic adapter |
| `cost.ts` usage metric mapping | ✅ Correct | Add cache write tokens for Anthropic |
| Tests | 🟡 Missing | Add for all new code paths |

---

## Recommended Fix Order

1. Remove `body.cache_control` from `translateAnthropicRequest()` (10 mins)
2. Remove `prompt_cache_key` and `prompt_cache_retention` from `translateOpenAIRequest()` (5 mins)
3. Add `cacheSystemPrompt?: boolean` to `LLMRequestOptions` in `types.ts` (5 mins)
4. Implement `cacheSystemPrompt` logic in `translateAnthropicRequest()` — inject on last system prompt block (30 mins)
5. Add `cacheWriteTokens` to `UsageMetrics` and map `cache_creation_input_tokens` in `cost.ts` (20 mins)
6. Add `cacheSystemPrompt` to `ConversationConfig` (15 mins)
7. Write tests for all the above (1–2 hours)

---

*Review based on `prompt_caching` branch vs `main` · April 2026*
