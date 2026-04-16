# Getting Started

This page gets a basic application working with the smallest possible integration.

## 1. Install The Library

Install from GitHub:

```bash
pnpm add github:07rjain/LLMlibrary
```

The package name you import is still `unified-llm-client`.

If you are working locally against a checked-out copy, you can also install with:

```bash
pnpm add file:../LLMlibrary
```

## 2. Add Environment Variables

Add a `.env` file in the consuming project, not in this repository.

```env
OPENAI_API_KEY=
OPENAI_ORG_ID=
OPENAI_PROJECT_ID=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
DATABASE_URL=
```

You only need the keys for the providers you actually use.

`DATABASE_URL` is optional unless you want Postgres-backed session persistence or usage logging.

## 3. Create A Client

The simplest entry point is `LLMClient.fromEnv()`.

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});
```

`defaultModel` becomes the fallback when an individual request does not pass `model`.

If you want to avoid environment variables, you can pass credentials directly:

```ts
import { LLMClient } from 'unified-llm-client';

const client = new LLMClient({
  defaultModel: 'gpt-4o',
  openaiApiKey: process.env.OPENAI_API_KEY,
});
```

## 4. Send Your First Request

Use `complete()` for non-streaming requests.

```ts
const response = await client.complete({
  messages: [
    {
      role: 'user',
      content: 'Explain what this library does in one sentence.',
    },
  ],
});

console.log(response.text);
console.log(response.model);
console.log(response.provider);
console.log(response.usage.cost);
```

The response is provider-agnostic. The most commonly used fields are:

- `response.text`
  The plain text output assembled from the assistant message
- `response.content`
  The canonical structured content parts
- `response.toolCalls`
  Any tool requests emitted by the model
- `response.finishReason`
  Why the generation ended
- `response.usage`
  Input tokens, output tokens, cached tokens, and estimated cost

## 5. Override Model Or Provider Per Request

You can keep one shared client and choose a different route on specific calls.

```ts
const response = await client.complete({
  model: 'gpt-4o-mini',
  provider: 'openai',
  messages: [{ role: 'user', content: 'Summarise this in five words.' }],
});
```

If you pass a provider without configuring its API key, the library throws an `AuthenticationError`.

## 6. Use A System Prompt

Pass `system` when you want a top-level instruction without manually building a system message into `messages`.

```ts
const response = await client.complete({
  system: 'You are concise, direct, and operational.',
  messages: [{ role: 'user', content: 'Write a standup update.' }],
});
```

## 7. Inspect The Model Registry

The client exposes a registry so your application can inspect or override model metadata.

```ts
const knownModels = client.models.list();
const modelInfo = client.models.get('gpt-4o');

console.log(knownModels.length);
console.log(modelInfo?.supportsStreaming);
console.log(modelInfo?.supportsTools);
```

This is useful when you want to expose model choices in an admin UI or enforce capability checks before sending a request.

## Common Import Patterns

Import from the root package when possible:

```ts
import {
  LLMClient,
  InMemorySessionStore,
  PostgresSessionStore,
  createSessionApi,
  defineTool,
} from 'unified-llm-client';
```

Use subpath imports only when you want a narrower surface:

```ts
import { OpenAIAdapter } from 'unified-llm-client/providers/openai';
import { calcCostUSD, estimateTokens } from 'unified-llm-client/utils';
```

## Common Startup Errors

- Missing model
  Set `defaultModel` on the client or pass `model` on the request.
- Missing provider credentials
  Add the matching provider key in the consuming project's environment.
- Wrong import name
  The package is installed from `LLMlibrary`, but the import id is `unified-llm-client`.
- Expecting automatic persistence without a store
  Persistence only happens when the client has a session store. If `DATABASE_URL` is present, `LLMClient.fromEnv()` auto-wires `PostgresSessionStore` for conversations.

## Next Step

If the first `complete()` call works, move to [Completions And Streaming](./COMPLETIONS_AND_STREAMING.md).
