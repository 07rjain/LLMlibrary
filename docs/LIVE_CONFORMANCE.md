# Live Provider Conformance

The opt-in conformance gate exercises the supported provider families with real credentials. It covers canonical completion, streaming, usage and cost reporting, and tool-call normalization for OpenAI, Anthropic, and Google.

Run it locally with credentials in the environment:

```bash
LIVE_CONFORMANCE=1 pnpm vitest run test/live-conformance.test.ts
```

The release workflow should run `pnpm test:conformance:live` with dedicated provider credentials before publishing. Local unit tests remain credential-free; this gate is intentionally explicit because it makes real provider requests and may incur usage charges.
