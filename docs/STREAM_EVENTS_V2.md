# Stream Events v2

`LLMClient.stream()` emits provider-neutral stream events with `version: 2`, a monotonic `sequence`, and an emission timestamp. When a request supplies `requestId`, the same identifier is copied to each event.

The v2 lifecycle includes `response-start`, `usage-update`, and `retry` events in addition to existing text, tool-call, error, and done events. Reasoning and response-status event types are reserved for providers that expose those signals. Consumers should branch on `chunk.type` and treat only `done` as terminal.

```ts
for await (const chunk of client.stream({
  messages: [{ role: 'user', content: 'Hello' }],
  requestId: 'request-123',
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
  if (chunk.type === 'done') console.log(chunk.usage);
}
```
