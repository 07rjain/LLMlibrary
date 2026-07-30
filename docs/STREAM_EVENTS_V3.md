# Stream Events v3

`LLMClient.stream()` emits provider-neutral stream events with `version: 3`, a monotonic `sequence`, and an emission timestamp. When a request supplies `requestId`, the same identifier is copied to each event.

`Conversation.sendStream()` preserves the same contract across automatic tool-loop follow-ups. Pass `requestId` in the `sendStream()` options when the complete conversation stream needs request correlation; the same ID is also sent to per-step context callbacks and usage logging.

The v3 lifecycle includes `response-start`, `usage-update`, and `retry` events in addition to text, tool-call, error, and done events. `tool-call-arguments` means provider arguments are complete and parsed. `tool-call-result` is reserved for the actual post-execution result from `Conversation.sendStream()` and includes `isError`. Reasoning and response-status events remain separate from visible text. Consumers should branch on `chunk.type` and treat only `done` as terminal.

Migration from v2: replace provider-side `tool-call-result` argument handling
with `tool-call-arguments`. Public output events use version 3. The only v2
compatibility retained is an explicitly versioned (`version: 2`)
`tool-call-result` accepted by `Conversation` as an internal argument alias;
unversioned results use v3 semantics and are rejected before tool execution.
The legacy alias is never forwarded to consumers.

Raw Gemini provider payloads may retain thought parts and thought signatures
for diagnostics and future replay support. Normalized visible text, content,
conversation history, and session output never expose those thought parts.

```ts
for await (const chunk of client.stream({
  messages: [{ role: 'user', content: 'Hello' }],
  requestId: 'request-123',
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
  if (chunk.type === 'done') console.log(chunk.usage);
}
```
