# Migration Guide

This guide shows how to move from raw provider SDK calls to the unified client surface.

## OpenAI Chat Completions to `LLMClient`

The unified client still accepts canonical `messages`, but the OpenAI adapter now translates them onto the Responses API internally. You do not need to migrate your application code to raw Responses payloads.

Raw SDK shape:

```ts
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Unified client shape:

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv({
  defaultModel: 'gpt-4o',
});

const response = await client.complete({
  messages: [{ content: 'Hello', role: 'user' }],
  provider: 'openai',
});
```

## Anthropic Messages to `Conversation`

Raw SDK shape:

```ts
const response = await anthropic.messages.create({
  max_tokens: 256,
  messages: [{ role: 'user', content: 'Summarise this ticket.' }],
  model: 'claude-sonnet-4-6',
});
```

Unified client shape:

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv();
const conversation = await client.conversation({
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  sessionId: 'ticket-summary',
});

await conversation.send('Summarise this ticket.');
```

## Gemini Generate Content to Tools

Raw SDK shape:

```ts
const response = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  { method: 'POST', body: JSON.stringify(payload) },
);
```

Unified client shape:

```ts
import { LLMClient, defineTool } from 'unified-llm-client';

const weather = defineTool({
  description: 'Look up weather by city',
  name: 'lookup_weather',
  parameters: {
    properties: {
      city: { type: 'string' },
    },
    required: ['city'],
    type: 'object',
  },
  async execute(args) {
    return { city: args.city, forecast: 'Sunny' };
  },
});

const client = LLMClient.fromEnv();
const conversation = await client.conversation({
  model: 'gemini-2.5-flash',
  provider: 'google',
  tools: [weather],
});

await conversation.send('What is the weather in Berlin?');
```

## Session Management Migration

- If you currently store raw provider transcripts yourself, move that persistence boundary to `Conversation` plus a `SessionStore`.
- If you need HTTP endpoints, mount `createSessionApi()` and treat `sessionId` as the provider-agnostic equivalent of a conversation or `previous_response_id` chain.
- If `DATABASE_URL` is present, `LLMClient.fromEnv()` will auto-wire `PostgresSessionStore.fromEnv()` unless you pass a custom store.
- Session API IDs are now server-owned by default, unknown-session message
  routes return `404`, and trusted-context tenancy fails closed without a
  middleware tenant. Trusted compatibility callers may set
  `allowClientSessionIds: true` or `allowImplicitSessionCreate: true`;
  single-tenant deployments should explicitly set
  `tenantResolution: 'single-tenant'`.

## Logging and Cost Tracking Migration

- Replace ad hoc token logging with `UsageLogger` implementations.
- Use `PostgresUsageLogger` when you need queryable aggregates through `client.getUsage()`.
- Treat all cost values as estimates based on the checked-in model registry rather than provider invoices.

## Fail-Closed Input Validation

Recent releases no longer silently clamp or forward several invalid values:

- explicit `chunkText()` sizes must be positive safe integers and overlap must
  be smaller than the chunk size
- tool names use the portable `[A-Za-z0-9_-]{1,64}` grammar and exact duplicate
  names are rejected
- OpenAI cache retention is `in_memory` or `24h`; Anthropic cache TTL is `5m`
  or `1h` with required `type: 'ephemeral'`
- TTS and transcription inputs now enforce documented formats, ranges, source
  exclusivity, and non-empty payloads
- budgets, duration estimates, and display costs reject negative or non-finite
  values while continuing to accept fractional values

These failures use `ProviderCapabilityError` with HTTP-style status `400` and
sanitized `details.code`, `details.option`, and `details.constraint` fields.
Validation happens before routing, mock queue consumption, provider fetches,
callbacks, or persisted conversation mutation.

Retrieval formatting now counts all omitted original results, marks any
omission as truncation, never reports an estimate above `maxTokens`, and wraps
each used block in explicit untrusted-content delimiters. Score descriptions
use uncalibrated rank/display terminology.
