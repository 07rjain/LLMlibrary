# Request Metadata

Completion and streaming requests accept an optional `requestId` and JSON-safe `metadata` map. The values are preserved by the request plan and copied into the corresponding `UsageEvent` when a usage logger is configured.

```ts
await client.complete({
  messages: [{ role: 'user', content: 'Hello' }],
  metadata: { purpose: 'answer', source: 'widget' },
  requestId: 'request-123',
});
```

The fields are provider-neutral. Applications can use them for correlation and attribution without requiring provider-specific request options.
