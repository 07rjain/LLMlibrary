# Request Cost Quotes

Use `client.estimateRequest()` to calculate a completion estimate before sending a request. The result includes estimated input, output, and reasoning tokens, the selected model and provider, the estimated USD cost, and the pricing snapshot version.

```ts
const quote = client.estimateRequest({
  maxTokens: 512,
  messages: [{ role: 'user', content: 'Summarize this document.' }],
});

console.log(quote.estimatedCostUSD, quote.priceVersion);
```

The quote uses the same model registry, token estimator, reasoning assumptions, and pricing data used by the request budget preflight. It does not send a provider request.
