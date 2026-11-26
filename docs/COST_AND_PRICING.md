# Cost And Pricing

Prepared: 2026-04-16  
Updated: 2026-11-15

See [current models, pricing, and retirements](./MODEL_CATALOG.md) for the verified
catalog, scheduled price changes, prompt-length tiers, and migration deadlines.

## Cost Semantics

- Cost outputs are estimates derived from [src/models/prices.json](../src/models/prices.json) plus provider token usage returned at runtime.
- The library treats provider-reported usage as authoritative whenever the provider returns token counts.
- Reasoning tokens are exposed as `usage.reasoningTokens` when the provider reports them. Gemini thought tokens are billed into `usage.costUSD` at the model output-token rate because Gemini reports them separately from visible candidate output tokens. OpenAI reasoning tokens are already included in provider `output_tokens`, so they are tracked but not billed a second time.
- `Conversation` totals and `UsageLogger` aggregates accumulate those estimated USD values, not provider billing exports.
- `Conversation.totals`, Session API cost views, and `client.getUsage()` include reasoning-token totals when available.
- Per-call `budgetUsd` preflight estimates include explicit Gemini `providerOptions.google.thinking.budgetTokens` as separately billable reasoning tokens. Provider-selected automatic thinking remains an estimate until the provider returns final usage.
- Every `budgetUsd` boundary accepts finite non-negative numbers, including
  fractional and very small USD limits. Negative values, numeric strings,
  `NaN`, and infinities fail before routing, warnings, mock queue consumption,
  provider dispatch, or logging.
- Completion budget actions are enforced before real transport or mock queue
  consumption for both `complete()` and `stream()`. `throw` raises
  `BudgetExceededError`; `skip` returns a synthetic error response with zero
  usage and emits one zero-cost usage event; `warn` continues dispatch and
  invokes the warning callback at most once per public operation, even when a
  route falls back. Warning callback errors are suppressed, and warning text is
  derived only from sanitized budget estimates and model/provider identifiers.
- Conversation-level budgets cover persisted spend across turns. Per-send
  budgets cover the current turn. When both are supplied, every automatic tool
  round receives the smaller remaining amount after subtracting applicable
  prior usage.
- `formatCost()` accepts finite non-negative numbers only. Use numeric
  `costUSD` values for arithmetic and call `formatCost()` only at display
  boundaries.
- Completion pricing fails closed. `calcCostUSD()`, request estimates, and
  budget preflight throw a non-retryable `ProviderCapabilityError` when a
  model is not registered instead of treating unknown pricing as free. A
  registered model whose validated input and output prices are genuinely zero
  still returns zero.
- The registry applies documented Standard-rate date schedules and prompt-length
  multipliers to the whole request. Haiku 5.5 tier selection includes separately
  reported cache reads and writes. Quotes and normalized usage use the same
  pricing calculation. Other execution modes, regional premiums, longer cache
  retention, cache storage, hosted tools, and modality-specific embedding rates
  remain outside the baseline estimate.

## Token Counting

- Anthropic and Gemini token counting use provider count-token endpoints.
- OpenAI token counting is now backed by the `js-tiktoken` tokenizer wrapper for text and tool messages.
- OpenAI multimodal prompt parts are intentionally rejected by the exact-count wrapper because image/audio/document accounting is provider-specific and not reliably reconstructible from canonical parts alone.

## Staleness Policy

- Each model price entry carries a `lastUpdated` field.
- Seeded entries also carry a `pricingSource`; announced complete rate cards are
  stored under `priceChanges`. Expired offers without documented successor rates
  fail closed using `pricingExpiresAt`. `pnpm pricecheck` checks both freshness
  and expired offers.
- Development warnings still trigger when pricing is older than 90 days.
- `pnpm pricecheck` enforces a tighter 45-day freshness target for automated maintenance.
- `.github/workflows/prices-drift.yml` runs that check weekly. Offers expiring
  in the next seven UTC days produce warnings and appear in `expiringModels`;
  they do not fail the check until their expiration date.
- Completion routes skip a model with expired pricing only if an explicitly
  configured route has another usable candidate. Budget estimates use the first
  usable candidate. A direct request or an all-expired route still fails before
  dispatch; the client does not choose a replacement model on its own.
- Newly released remote models discovered through `client.models.listRemote({ provider })` are not automatically priced or routable until they are explicitly registered.
- `client.updatePrices()` accepts finite non-negative numeric prices, including
  zero/free pricing, and validates nested cache and speech billing units. A
  mixed valid/invalid override batch is rejected atomically without changing
  any model record.
- Every `ModelRegistry` constructor seed is validated before the registry is
  populated. Missing, negative, `NaN`, or infinite prices and invalid model
  metadata reject the entire constructor call.

## Accuracy Expectations

- Token totals remain exact only when the provider exposes authoritative counts or when the tokenizer contract is stable enough to reproduce locally.
- USD totals should be treated as operational estimates for routing, budgets, and reporting rather than invoice-grade accounting.
- Consumers that need billing reconciliation should compare library output with provider-side usage exports.
- Provider invoices can still differ because of execution mode, tool charges,
  cache retention/storage, regional pricing, modality-specific rates, or token
  estimates. Published prompt-length tiers and scheduled Standard rate changes
  are included where present in the registry.
