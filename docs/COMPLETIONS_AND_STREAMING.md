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

## JSON And Structured Output

Use `responseFormat` when your application needs JSON instead of free-form text.
The same option works on direct `complete()` calls, `conversation()`, and the
Session API. Non-streaming `complete()` responses are parsed into
`response.parsed` by default.

```ts
const response = await client.complete({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Return the user profile.' }],
  responseFormat: {
    type: 'json_schema',
    name: 'user_profile',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        plan: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
      },
      required: ['name', 'plan'],
    },
  },
});

console.log(response.parsed);
console.log(response.structuredOutputStatus);
```

Supported modes:

- `responseFormat: { type: 'json_schema', schema, name?, strict?, parse? }`
  requests provider-native schema output where supported.
- `responseFormat: { type: 'json_object', parse? }` requests provider-native
  JSON object mode where supported.
- `parse: false` keeps the provider output as text and marks
  `structuredOutputStatus` as `disabled`.

Provider behavior:

- OpenAI uses the Responses API `text.format` field. For `json_object`, at
  least one system or message text must contain the literal string `JSON`; the
  library rejects the request before dispatch when it is missing. For
  `json_schema`, OpenAI strict schemas are normalized before dispatch so object
  properties are required and `additionalProperties: false` is applied.
- Gemini uses `generationConfig.responseMimeType = 'application/json'` plus
  `responseSchema` for most generateContent models. `gemini-3.5-*` uses the
  newer `generationConfig.responseFormat.text.mimeType = 'APPLICATION_JSON'`
  envelope.
- Anthropic supports `json_schema` through `output_config.format`. Anthropic
  `json_object` without a schema is intentionally unsupported in v1; use
  `json_schema` instead.

The first release intentionally accepts a portable schema subset: `type`,
`properties`, `required`, `items`, `enum`, `description`, and boolean
`additionalProperties`. Keywords such as `anyOf`, `$ref`, numeric/string/array
constraints, `format`, `title`, and `prefixItems` are rejected for now even when
some providers support them.

If parsing fails, the call does not throw. The response includes
`structuredOutputStatus: 'parse_error'` and `parseError`. Provider refusals are
reported as `structuredOutputStatus: 'refusal'` with `response.refusal`, so they
are not treated as malformed JSON.

Streaming currently supports request mapping only. The stream chunks stay
canonical (`text-delta`, tool chunks, `done`) and do not include parsed JSON
metadata in v1.

## Reasoning And Thinking Controls

Reasoning controls are exposed through provider-specific options. This is intentional: OpenAI, Anthropic, and Gemini use different request fields and the values are not perfectly portable across model families.

OpenAI Responses API reasoning options:

```ts
const response = await client.complete({
  model: 'gpt-5',
  maxTokens: 800,
  messages: [{ role: 'user', content: 'Solve this step by step.' }],
  providerOptions: {
    openai: {
      reasoning: {
        effort: 'medium',
        summary: 'auto',
      },
    },
  },
});

console.log(response.usage?.reasoningTokens);
```

Set `includeEncryptedContent: true` only when your application is ready to preserve OpenAI encrypted reasoning items for later continuation:

```ts
await client.complete({
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'Continue the analysis.' }],
  providerOptions: {
    openai: {
      reasoning: {
        effort: 'low',
        includeEncryptedContent: true,
      },
    },
  },
});
```

Anthropic thinking options:

```ts
await client.complete({
  model: 'claude-sonnet-4-6',
  maxTokens: 1200,
  messages: [{ role: 'user', content: 'Review this migration plan.' }],
  providerOptions: {
    anthropic: {
      effort: 'medium',
      thinking: {
        type: 'adaptive',
        display: 'omitted',
      },
    },
  },
});
```

For Claude models that support manual budgets, use `budgetTokens`; the library rejects manual thinking budgets that are greater than or equal to `maxTokens` before sending the request:

```ts
await client.complete({
  model: 'claude-sonnet-4-6',
  maxTokens: 2000,
  messages: [{ role: 'user', content: 'Analyze this incident timeline.' }],
  providerOptions: {
    anthropic: {
      thinking: {
        type: 'enabled',
        budgetTokens: 1024,
        display: 'summarized',
      },
    },
  },
});
```

Gemini thinking options:

```ts
await client.complete({
  model: 'gemini-2.5-flash',
  maxTokens: 700,
  messages: [{ role: 'user', content: 'Find the risks in this proposal.' }],
  providerOptions: {
    google: {
      thinking: {
        budgetTokens: 0,
        includeThoughts: false,
      },
    },
  },
});
```

For Gemini model families that use thinking levels:

```ts
await client.complete({
  model: 'gemini-3-pro',
  messages: [{ role: 'user', content: 'Compare these two designs.' }],
  providerOptions: {
    google: {
      thinking: {
        level: 'low',
        includeThoughts: false,
      },
    },
  },
});
```

Reasoning and thinking tokens can increase latency and cost, and they may consume part of the provider's output budget. The library exposes provider-reported counts as `usage.reasoningTokens` when the upstream response includes them. Gemini reports thought tokens separately from candidate output tokens, so they are included in `usage.costUSD` at the model output-token rate. OpenAI reports reasoning tokens inside output usage, so they are not billed a second time by the library. Explicit Gemini `thinking.budgetTokens` values are also included in `budgetUsd` preflight estimates. Reasoning summaries, Anthropic thinking blocks, and Gemini thoughts are not merged into `response.text` by default.

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
