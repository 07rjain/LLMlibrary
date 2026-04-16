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

const response = await conversation.send('Summarise the issue in one paragraph.');

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

## Inspect And Export State

The `Conversation` instance exposes several useful methods:

- `conversation.history`
  Non-system message history
- `conversation.toMessages()`
  Full message list, including the pinned system prompt
- `conversation.totals`
  Aggregate input tokens, output tokens, cached tokens, and cost
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

### How Tool Execution Works

When the model returns a tool call:

1. The library captures the tool request.
2. It executes the matching `execute()` function.
3. It appends a canonical `tool_result` message.
4. It sends the updated history back to the model.
5. It repeats until the model stops or `maxToolRounds` is reached.

If the loop exceeds `maxToolRounds`, the library throws `MaxToolRoundsError`.

## Control Tool Behavior

Useful conversation options:

- `tools`
  Registered tool definitions
- `toolChoice`
  Control whether the model may call tools, must call a specific tool, or must not call any
- `maxToolRounds`
  Guard against runaway tool loops
- `toolExecutionTimeoutMs`
  Per-tool timeout for `execute()`

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

```ts
const conversation = await client.conversation({
  sessionId: 'budgeted-thread',
  budgetUsd: 0.25,
  budgetExceededAction: 'warn',
});
```

Supported actions:

- `throw`
  Fail immediately when the estimated next request would exceed budget
- `warn`
  Continue, but trigger the configured warning callback
- `skip`
  Skip the model call and return a synthetic budget-exceeded response

## Practical Rule

- Use `complete()` for stateless work.
- Use `conversation()` when the next turn depends on previous turns.
- Add tools only when a prompt-only answer is not reliable enough.

## Next Step

If you need durable storage, usage aggregation, or HTTP endpoints, continue with [Persistence And Session API](./PERSISTENCE_AND_SESSION_API.md).
