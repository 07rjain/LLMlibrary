# Prompt Caching Live Tests

This folder holds the dedicated cross-provider prompt caching checks for the `prompt_caching` branch.

## What It Covers

- OpenAI repeated Responses requests with `prompt_cache_key` and `prompt_cache_retention`
- Anthropic cache writes and cache reads with explicit `cache_control`
- Gemini explicit cache lifecycle plus cached reuse through `cachedContent`

## Environment

- `test/prompt_caching_test/.env` is loaded automatically by the test helper
- existing shell environment variables still win if they are already set

## Run

```bash
pnpm test:prompt-caching:live
```

The test logs a compact JSON line per provider so a separate agent or CI run can inspect the observed cached-token behavior.
