# Completions And Streaming

This page covers the two base execution modes:

- `client.complete()` for one-shot responses
- `client.stream()` for incremental output

## Complete Requests

Use `complete()` when you want one resolved response object.

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const response = await client.complete({
  maxTokens: 300,
  temperature: 0.2,
  messages: [
    { role: 'user', content: 'Write a two-line release note for a bug fix.' },
  ],
});

console.log(response.text);
console.log(response.finishReason);
console.log(response.usage);
```

### Request Options You Will Use Most Often

- `messages`
  Canonical chat history
- `model`
  The model id for this request
- `provider`
  Provider override when you want to force a route
- `system`
  Top-level system prompt
- `maxTokens`
  Maximum generated output tokens
- `temperature`
  Sampling control
- `tools` and `toolChoice`
  Tool definitions and tool policy
- `sessionId` and `tenantId`
  Tracking fields used by persistence, routing, and usage logging
- `budgetUsd`
  Estimated spend cap for the request

## Message Shapes

Plain text messages are the most common case:

```ts
const response = await client.complete({
  messages: [
    { role: 'user', content: 'Summarise this ticket in one sentence.' },
  ],
});
```

The library also supports structured multimodal parts:

```ts
const response = await client.complete({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe what is in this image.' },
        {
          type: 'image_url',
          url: 'https://example.com/diagram.png',
          mediaType: 'image/png',
        },
      ],
    },
  ],
});
```

The benefit of the canonical message format is that your application code does not have to branch deeply by provider once the request is inside the library.

## Streaming Requests

Use `stream()` when the caller needs tokens as they arrive.

```ts
const stream = client.stream({
  messages: [{ role: 'user', content: 'Stream a short product update.' }],
});

let text = '';

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') {
    text += chunk.delta;
    process.stdout.write(chunk.delta);
  }

  if (chunk.type === 'done') {
    console.log('\nusage', chunk.usage);
  }
}
```

### Stream Chunk Types

- `text-delta`
  Incremental text content
- `tool-call-start`
  The model started building a tool call
- `tool-call-delta`
  Partial tool-call argument JSON
- `tool-call-result`
  Executed tool result surfaced back into the stream
- `done`
  Final usage and finish reason
- `error`
  Terminal error frame

## Cancel A Stream

The returned stream is cancelable.

```ts
const stream = client.stream({
  messages: [{ role: 'user', content: 'Write a long answer.' }],
});

setTimeout(() => {
  stream.cancel(new Error('Client disconnected.'));
}, 200);

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.delta);
  }
}
```

This is especially useful in HTTP servers where the browser tab may close before the model finishes.

## Estimated Cost And Token Helpers

For preflight estimates and display formatting, the library exports helpers from `unified-llm-client/utils`.

```ts
import {
  estimateMessageTokens,
  formatCost,
  openaiCountTokens,
} from 'unified-llm-client/utils';

const messages = [{ role: 'user', content: 'Estimate token count for this request.' }];

console.log(estimateMessageTokens(messages));
console.log(formatCost(0.0132));
console.log(await openaiCountTokens({ messages, model: 'gpt-4o' }));
```

Use `estimateMessageTokens()` for lightweight approximations and `openaiCountTokens()` when you want closer OpenAI-specific counting.

## Error Handling

Provider-specific transport differences are normalized into library errors.

```ts
import {
  AuthenticationError,
  ProviderError,
  RateLimitError,
} from 'unified-llm-client';

try {
  await client.complete({
    messages: [{ role: 'user', content: 'Hello' }],
  });
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Check your provider API key configuration.');
  } else if (error instanceof RateLimitError) {
    console.error('Retry later or route to a fallback model.');
  } else if (error instanceof ProviderError) {
    console.error('Provider responded with an upstream error.');
  } else {
    throw error;
  }
}
```

## When To Use `complete()` Vs `stream()`

- Use `complete()` for background jobs, cron tasks, and simple server endpoints.
- Use `stream()` for chat UIs, CLI tools, and long-form responses where latency matters.
- Use `conversation()` instead of manually passing history once you need multi-turn state or tool loops.

## Next Step

If you need persistent history, context management, or tool execution, continue with [Conversations And Tools](./CONVERSATIONS_AND_TOOLS.md).
