# Conversations And Tools

Use `Conversation` when you want the library to manage state across turns.

This is the layer that gives you:

- Stored message history
- Running token and cost totals
- Automatic conversation restore by `sessionId`
- Automatic tool execution loops
- Context trimming and summarisation hooks

## Start A Conversation

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const conversation = await client.conversation({
  sessionId: 'customer-support-42',
  system: 'You are concise, helpful, and operational.',
});

const response = await conversation.send(
  'Summarise the issue in one paragraph.',
);

console.log(response.text);
console.log(conversation.id);
console.log(conversation.totals);
```

Unlike `complete()`, you do not pass full history every time. Each `send()` appends a user turn and the assistant response to the stored conversation state.

## Restore An Existing Conversation

If the client has a session store configured, calling `conversation({ sessionId })` restores the saved snapshot automatically.

```ts
const conversation = await client.conversation({
  sessionId: 'customer-support-42',
});

console.log(conversation.toMessages());
```

If no stored session exists, the library creates a new conversation with that id.

When a stored snapshot is restored, the saved message history and usage totals
are reused, but current caller options should be treated as the trusted runtime
policy. Pass the current `system`, tenant, model/provider, budget, tool
validation, tool limits, response format, and registered tools when those values
must be enforced for a request. Snapshot hydration is fail-closed: malformed
messages, timestamps, totals, unsafe descriptors, cycles, and non-finite numeric
state throw `InvalidConversationSnapshotError` before a conversation is
constructed. Trusted runtime overrides do not bypass validation of corrupt
stored fields. Do not import or trust client-controlled snapshots as
authoritative policy.

## Inspect And Export State

The `Conversation` instance exposes several useful methods:

- `conversation.history`
  Non-system message history
- `conversation.toMessages()`
  Full message list, including the pinned system prompt
- `conversation.totals`
  Aggregate input tokens, output tokens, reasoning tokens, cached tokens, and cost
- `conversation.toMarkdown()`
  Markdown transcript export
- `conversation.serialise()`
  Raw snapshot payload used for persistence
- `conversation.clear()`
  Clears non-system history while preserving totals

Example:

```ts
console.log(conversation.toMarkdown());
```

## Stream A Conversation Turn

Conversation streaming behaves like `client.stream()`, but it also persists the final state once the turn finishes.

```ts
const stream = conversation.sendStream('Write a concise customer reply.');

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.delta);
  }
}
```

`conversation.sendStream()` also supports `.cancel()` because it returns the same cancelable stream abstraction as `client.stream()`.

Calls to `send()` and consumed `sendStream()` instances on the same
`Conversation` run in FIFO order. Each turn sees the history and totals committed
by the preceding turn. Creating a stream without iterating it does not occupy
the queue. If a consumer stops before the stream finishes, call `.cancel()` or
the iterator's `.return()` method (a `for await` early exit does this
automatically) so the next queued turn can start.

While a tool callback is running, starting another `send()` or beginning
iteration of another `sendStream()` on that same `Conversation` fails with a
non-retryable `conversation_busy` error. This prevents a tool from deadlocking
or mutating its own conversation after a timeout. The same narrow guard also
rejects an external caller that arrives during the callback because portable
edge runtimes cannot reliably distinguish callback ownership. A timed-out tool
that ignores cancellation keeps the guard until its callback actually settles;
turns already queued before that callback began are checked again when they
acquire the FIFO slot and reject rather than running alongside it. Ordinary
overlapping turns outside tool callbacks continue to use FIFO order.

## Add Tools

Use `defineTool()` for strong TypeScript inference around tool arguments.

```ts
import { LLMClient, defineTool } from 'unified-llm-client';

const weather = defineTool({
  name: 'lookup_weather',
  description: 'Look up weather by city name',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'The city to look up' },
    },
    required: ['city'],
  },
  async execute(args) {
    return {
      city: args.city,
      forecast: 'Sunny',
      temperatureC: 24,
    };
  },
});

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const conversation = await client.conversation({
  sessionId: 'weather-demo',
  tools: [weather],
});

const response = await conversation.send('What is the weather in Berlin?');

console.log(response.text);
```

`defineTool()` remains identity-preserving for TypeScript inference.
Definitions are validated when they reach an execution or provider-translation
boundary. Names must match `[A-Za-z0-9_-]{1,64}`, descriptions must be
non-empty, and `parameters` must be an accessor-free, acyclic JSON-safe schema
whose root type is `object`. Duplicate names are rejected exactly and
case-sensitively before routing or dispatch.

### How Tool Execution Works

When the model returns a tool call:

1. The library captures the tool request.
2. It executes the matching `execute()` function.
3. It appends a canonical `tool_result` message.
4. It sends the updated history back to the model.
5. It repeats until the model stops or `maxToolRounds` is reached.

Gemini models may require opaque thought signatures from assistant tool-call
content to be replayed with the tool result. `Conversation` handles this for
both `send()` and `sendStream()` without adding signatures or hidden thought
text to canonical history, public tool arguments, or stream events. Replay
state is provider- and exact-model-bound, so another provider or model never
receives it.

If the loop exceeds `maxToolRounds`, the library throws `MaxToolRoundsError`.

## Control Tool Behavior

Useful conversation options:

- `tools`
  Registered tool definitions
- `toolChoice`
  Control whether the model may call tools, must call a specific tool, or must not call any
- `maxToolRounds`
  Guard against runaway tool loops. Values must be finite integers between `0`
  and `100`.
- `toolExecutionTimeoutMs`
  Per-tool timeout for `execute()`. Values must be finite positive numbers up
  to `300000`. The callback receives `context.signal`; long-running tools
  should pass it to fetch, database, or queue clients and stop when it aborts.
- `toolValidation`
  Defaults to `strict`, which validates model-provided tool arguments against
  `parameters` before `execute()` runs. Strict mode requires own object
  properties, rejects prototype-sensitive argument keys, and rejects unsupported
  schema types. Use `permissive` only for legacy callbacks that validate
  arguments themselves.

Force a specific tool:

```ts
const conversation = await client.conversation({
  sessionId: 'weather-demo',
  tools: [weather],
  toolChoice: { type: 'tool', name: 'lookup_weather' },
  maxToolRounds: 2,
});
```

## Manage Context Size

Use a context manager when conversations grow beyond the prompt budget you want to send.

### Sliding Window

```ts
import { SlidingWindowStrategy } from 'unified-llm-client';

const conversation = await client.conversation({
  sessionId: 'support-thread',
  contextManager: new SlidingWindowStrategy({
    maxMessages: 12,
    maxTokens: 16_000,
  }),
});
```

This keeps the most recent messages inside a bounded window.

Custom context managers receive isolated message snapshots. A mutation inside
`shouldTrim()` is discarded, and `trim()` output is validated and cloned as
dense canonical messages before compaction callbacks, provider dispatch, or
session persistence. Invalid output fails with `ProviderCapabilityError`
status `400`; an exception thrown by the custom manager itself is propagated
unchanged.

### Summarisation

```ts
import { SummarisationStrategy } from 'unified-llm-client';

const conversation = await client.conversation({
  sessionId: 'long-running-thread',
  contextManager: new SummarisationStrategy({
    keepLastMessages: 2,
    maxMessages: 10,
    summarizer: async (messages) => {
      const result = await client.complete({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: `Summarise this conversation:\n${JSON.stringify(messages)}`,
          },
        ],
      });

      return result.text;
    },
  }),
});
```

Use this when you need very long-lived sessions but still want the model to retain older context in compressed form.

## Budget Controls

Conversations can enforce a spend cap with `budgetUsd`.

The cap must be a finite non-negative number. Fractional and very small USD
values are valid; negative values, numeric strings, `NaN`, and infinities fail
before routing or warning callbacks.

```ts
const conversation = await client.conversation({
  sessionId: 'budgeted-thread',
  budgetUsd: 0.25,
  budgetExceededAction: 'warn',
});
```

You can also set a stricter cap, output limit, or action for one turn. A
per-send `budgetUsd` is a turn cap: the library subtracts usage from earlier
automatic tool rounds in that turn. When both a conversation cap and per-send
cap exist, each round receives the smaller remaining amount. A per-send action
overrides the conversation action for that turn.

```ts
await conversation.send('Run the analysis.', {
  budgetUsd: 0.05,
  maxTokens: 800,
  budgetExceededAction: 'skip',
});
```

The remaining conversation cap subtracts both spend persisted by earlier turns
and usage accumulated by earlier model/tool rounds in the current turn. The
guard runs before every model round, including the round after a tool result.

Supported actions:

- `throw`
  Fail immediately when the estimated next request would exceed budget
- `warn`
  Continue, but trigger the configured warning callback at most once for the
  operation. Warning text contains only sanitized budget/model/provider data,
  and exceptions thrown by the callback are ignored.
- `skip`
  Skip the model call and return a synthetic budget-exceeded response with
  zero usage. Direct client skips emit one zero-cost usage event. Conversation
  history retains the user turn and any real tool-loop messages, but never
  stores the synthetic budget error as an assistant reply.

## Practical Rule

- Use `complete()` for stateless work.
- Use `conversation()` when the next turn depends on previous turns.
- Add tools only when a prompt-only answer is not reliable enough.

## Next Step

If you need durable storage, usage aggregation, or HTTP endpoints, continue with [Persistence And Session API](./PERSISTENCE_AND_SESSION_API.md).
