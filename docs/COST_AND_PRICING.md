# Cost And Pricing

Prepared: 2026-04-16

## Cost Semantics

- Cost outputs are estimates derived from [src/models/prices.json](/Users/rishabh/Desktop/tryandtested/chatbot101/src/models/prices.json) plus provider token usage returned at runtime.
- The library treats provider-reported usage as authoritative whenever the provider returns token counts.
- `Conversation` totals and `UsageLogger` aggregates accumulate those estimated USD values, not provider billing exports.

## Token Counting

- Anthropic and Gemini token counting use provider count-token endpoints.
- OpenAI token counting is now backed by the `js-tiktoken` tokenizer wrapper for text and tool messages.
- OpenAI multimodal prompt parts are intentionally rejected by the exact-count wrapper because image/audio/document accounting is provider-specific and not reliably reconstructible from canonical parts alone.

## Staleness Policy

- Each model price entry carries a `lastUpdated` field.
- Development warnings still trigger when pricing is older than 90 days.
- `pnpm pricecheck` enforces a tighter 45-day freshness target for automated maintenance.
- `.github/workflows/prices-drift.yml` runs that check weekly so stale pricing does not silently linger.

## Accuracy Expectations

- Token totals remain exact only when the provider exposes authoritative counts or when the tokenizer contract is stable enough to reproduce locally.
- USD totals should be treated as operational estimates for routing, budgets, and reporting rather than invoice-grade accounting.
- Consumers that need billing reconciliation should compare library output with provider-side usage exports.
