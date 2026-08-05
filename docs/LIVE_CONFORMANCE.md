# Live Provider Conformance

The opt-in conformance gate exercises the supported provider families with real credentials. It covers canonical completion, streaming, usage and cost reporting, and tool-call normalization for OpenAI, Anthropic, and Google.

Run it locally with credentials in the environment:

```bash
LIVE_CONFORMANCE=1 pnpm vitest run test/live-conformance.test.ts
```

The release workflow should run `pnpm test:conformance:live` with dedicated provider credentials before publishing. Local unit tests remain credential-free; this gate is intentionally explicit because it makes real provider requests and may incur usage charges.

## Model selection

The generic live matrix defaults to the registry-backed low-cost models below:

| Provider | Default | Override precedence |
| --- | --- | --- |
| OpenAI | `gpt-5.6-luna` | `LIVE_OPENAI_MODEL`, then `LIVE_REAL_OPENAI_MODEL` |
| Anthropic | `claude-haiku-4-5-20251001` | `LIVE_ANTHROPIC_MODEL`, then `LIVE_REAL_ANTHROPIC_MODEL` |
| Gemini | `gemini-3.1-flash-lite` | `LIVE_GEMINI_MODEL`, then `LIVE_REAL_GEMINI_MODEL` |

Set an override when a provider account does not expose the default model. The `LIVE_REAL_*` names are retained for existing adapter suites. These variables select models only; `client.models.listRemote({ provider })` is still discovery data and does not modify the local registry. Gemini reasoning/cache tests intentionally use their separate capability-specific model overrides.
