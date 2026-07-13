# LLMlibrary Live Feature Fix Verification

Date: 2026-07-13

This note follows up on the July 13 live feature report that flagged OpenAI
multi-turn replay, stream cancellation, Gemini structured output, and Anthropic
schema strictness.

## Fixed

- OpenAI assistant history replay now serializes assistant text as Responses
  `output_text`, not `input_text`.
- `stream.cancel()` now stops already-buffered chunks from being yielded by the
  shared cancelable stream wrapper.
- Gemini structured output now uses a working generateContent payload:
  `responseMimeType` / `responseSchema` for most Gemini models, and the
  `responseFormat.text.mimeType = "APPLICATION_JSON"` envelope for
  `gemini-3.5-*`.
- Anthropic `json_schema` output now closes object schemas with
  `additionalProperties: false` during normalization.
- ESLint now ignores generated `security_scan/<scan_id>/` working trees, matching
  `.gitignore`.

## Still By Design

- `getUsage()` / `exportUsage()` still require a usage logger that implements
  aggregation, such as `PostgresUsageLogger`. Per-response `usage.costUSD`
  remains available without Postgres.

## Verification

Local:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` - 569 passed, 49 skipped
- `pnpm build`

Focused regressions:

- `test/openai.adapter.test.ts`
- `test/gemini.adapter.test.ts`
- `test/anthropic.adapter.test.ts`
- `test/client.test.ts`
- `test/structured-output.test.ts`

Live real-key harness:

- `node /private/tmp/llmlibrary_live_fix_check.mjs`
- OpenAI two-turn conversation on `gpt-5.4-nano`: passed.
- OpenAI cancel after first stream chunk: passed.
- Gemini structured JSON on `gemini-2.5-flash`: passed and parsed.
- Anthropic structured JSON could not complete because the account reported low
  API credits; local request-shape regression passed.

Gemini 3.5 note:

- Direct live probes confirmed `gemini-3.5-flash` rejects the old
  `responseFormat.text.mimeType = "application/json"` shape.
- Direct live probes confirmed `gemini-3.5-flash` accepts
  `responseFormat.text.mimeType = "APPLICATION_JSON"`.
- A final library-level 3.5 run was blocked by the provider free-tier quota after
  the probes; local tests cover the exact 3.5 request shape.
