# Request Metadata and Usage Correlation

Completion and streaming requests accept JSON-safe request metadata and an
optional request identifier:

```ts
const response = await client.complete({
  messages: [{ role: 'user', content: 'Summarize this ticket.' }],
  metadata: { tenantPlan: 'pro', feature: 'ticket-summary' },
  requestId: 'http-request-123',
});
```

The values are copied to the corresponding `UsageEvent` sent to the configured
usage logger. Metadata is application context; it is not sent to providers.
`requestId` is also copied to v3 stream events.

Metadata is validated and cloned before dispatch. It may contain only null,
booleans, strings, finite numbers, arrays, and plain or null-prototype objects.
Undefined values, BigInt, symbols, functions, non-finite numbers, cycles,
custom prototypes, symbol keys, accessors, and excessively deep graphs reject
with a typed HTTP-400-compatible `ProviderCapabilityError`. Accessors are
inspected without invoking getters, and later caller mutation cannot change the
captured request metadata.

Conversation turns accept the same options:

```ts
await conversation.send('Summarize this ticket.', {
  metadata: { feature: 'ticket-summary' },
  requestId: 'http-request-123',
});

for await (const chunk of conversation.sendStream('Stream the summary.', {
  metadata: { feature: 'ticket-summary' },
  requestId: 'http-request-124',
})) {
  render(chunk);
}
```

The caller-supplied request ID is passed to every per-step context callback and
every provider attempt in an automatic tool loop. If no ID is supplied, context
callbacks retain the deterministic `sessionId:toolRound` fallback.

The Session API accepts both fields in `POST /sessions/{id}/message` requests
and forwards them to the underlying conversation and usage logger. Metadata
must contain JSON values only; secrets and credentials should never be placed
in request metadata.
