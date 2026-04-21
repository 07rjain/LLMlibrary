import { afterAll, describe, expect, it } from 'vitest';

import { LLMClient } from '../src/client.js';

const liveEnabled = process.env.LIVE_TESTS === '1';
const liveDescribe = liveEnabled ? describe : describe.skip;

function liveIt(enabled: boolean) {
  return enabled ? it : it.skip;
}

liveDescribe('live smoke', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const action of cleanup.reverse()) {
      await action();
    }
  });

  liveIt(Boolean(process.env.OPENAI_API_KEY))(
    'completes a minimal request against OpenAI',
    async () => {
      const client = LLMClient.fromEnv();
      const response = await client.complete({
        maxTokens: 32,
        messages: [{ content: 'Reply with a short greeting.', role: 'user' }],
        model: 'gpt-4o-mini',
        provider: 'openai',
        temperature: 0,
      });

      expect(response.provider).toBe('openai');
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.costUSD).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.OPENAI_API_KEY))(
    'accepts OpenAI prompt caching hints on a live request',
    async () => {
      const client = LLMClient.fromEnv();
      const cachedPrefix = 'Support FAQ: Refunds are available within 30 days.\n'.repeat(80);
      const response = await client.complete({
        maxTokens: 32,
        messages: [
          {
            content: `${cachedPrefix}\nReply with exactly LIVE_OPENAI_CACHE_OK.`,
            role: 'user',
          },
        ],
        model: 'gpt-4o-mini',
        provider: 'openai',
        providerOptions: {
          openai: {
            promptCaching: {
              key: `live-openai-cache-${Date.now()}`,
              retention: 'in_memory',
            },
          },
        },
        temperature: 0,
      });

      expect(response.provider).toBe('openai');
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.cachedTokens).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.ANTHROPIC_API_KEY))(
    'completes a minimal request against Anthropic',
    async () => {
      const client = LLMClient.fromEnv();
      const response = await client.complete({
        maxTokens: 32,
        messages: [{ content: 'Reply with a short greeting.', role: 'user' }],
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        temperature: 0,
      });

      expect(response.provider).toBe('anthropic');
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.costUSD).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.ANTHROPIC_API_KEY))(
    'accepts Anthropic cache-control hints on a live request',
    async () => {
      const client = LLMClient.fromEnv();
      const cachedPolicy = 'Policy excerpt: Refunds are available within 30 days.\n'.repeat(80);
      const response = await client.complete({
        maxTokens: 32,
        messages: [
          {
            content: [
              {
                cacheControl: { type: 'ephemeral' },
                text: cachedPolicy,
                type: 'text',
              },
              {
                text: 'Reply with exactly LIVE_ANTHROPIC_CACHE_OK.',
                type: 'text',
              },
            ],
            role: 'user',
          },
        ],
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        providerOptions: {
          anthropic: {
            cacheControl: { type: 'ephemeral' },
          },
        },
        temperature: 0,
      });

      expect(response.provider).toBe('anthropic');
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.cachedTokens).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.GEMINI_API_KEY))(
    'completes a minimal request against Gemini',
    async () => {
      const client = LLMClient.fromEnv();
      const response = await client.complete({
        maxTokens: 32,
        messages: [{ content: 'Reply with a short greeting.', role: 'user' }],
        model: 'gemini-2.5-flash',
        provider: 'google',
        temperature: 0,
      });

      expect(response.provider).toBe('google');
      expect(response.usage.costUSD).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.GEMINI_API_KEY))(
    'creates, reuses, updates, lists, and deletes a Gemini explicit cache',
    async () => {
      const client = LLMClient.fromEnv();
      const cache = await client.googleCaches.create({
        displayName: `live-cache-${Date.now()}`,
        messages: [
          {
            content: 'Support FAQ: Refunds are available within 30 days.\n'.repeat(80),
            role: 'user',
          },
        ],
        model: 'gemini-2.5-flash',
        ttl: '600s',
      });

      cleanup.push(async () => {
        try {
          await client.googleCaches.delete(cache.name);
        } catch {
          return;
        }
      });

      const fetched = await client.googleCaches.get(cache.name);
      const updated = await client.googleCaches.update(cache.name, {
        ttl: '900s',
      });
      const listed = await client.googleCaches.list({ pageSize: 100 });
      const response = await client.complete({
        maxTokens: 32,
        messages: [{ content: 'Reply with exactly LIVE_GEMINI_CACHE_OK.', role: 'user' }],
        model: 'gemini-2.5-flash',
        provider: 'google',
        providerOptions: {
          google: {
            promptCaching: {
              cachedContent: cache.name,
            },
          },
        },
        temperature: 0,
      });

      expect(cache.name).toMatch(/^cachedContents\//);
      expect(fetched.name).toBe(cache.name);
      expect(updated.name).toBe(cache.name);
      expect(listed.cachedContents.some((item) => item.name === cache.name)).toBe(true);
      expect(response.provider).toBe('google');
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.cachedTokens).toBeGreaterThan(0);
    },
    30_000,
  );

  liveIt(Boolean(process.env.OPENAI_API_KEY) && Boolean(process.env.DATABASE_URL))(
    'persists and restores a session through the default Postgres session store',
    async () => {
      const sessionId = `live_session_${Date.now()}`;
      const client = LLMClient.fromEnv({
        defaultModel: 'gpt-4o',
      });
      const store = client.getSessionStore();
      if (!store) {
        throw new Error('Expected LLMClient.fromEnv() to configure a session store.');
      }

      cleanup.push(async () => {
        await store.delete(sessionId);
        if ('close' in store && typeof store.close === 'function') {
          await store.close();
        }
      });

      const conversation = await client.conversation({
        sessionId,
        system: 'Reply with exactly LIVE_STORE_OK.',
      });
      const response = await conversation.send('Reply with exactly LIVE_STORE_OK.');
      const restored = await client.conversation({ sessionId });

      expect(response.text.length).toBeGreaterThan(0);
      expect(
        restored.toMessages().some((message) => {
          const content = message.content;
          return typeof content === 'string' && content.length > 0;
        }),
      ).toBe(true);
    },
    20_000,
  );
});
