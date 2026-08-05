import { afterAll, describe, expect, it } from 'vitest';

import { LLMClient } from '../src/client.js';
import { getLiveModelMatrix, liveTemperature } from './live-models.js';

const liveEnabled = process.env.LIVE_TESTS === '1';
const liveDescribe = liveEnabled ? describe : describe.skip;
const liveModels = getLiveModelMatrix();

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
        model: liveModels.openai,
        provider: 'openai',
        ...liveTemperature('openai', liveModels.openai),
      });

      expect(response.provider).toBe('openai');
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.costUSD).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.ANTHROPIC_API_KEY))(
    'completes a minimal request against Anthropic',
    async () => {
      const client = LLMClient.fromEnv();
      const response = await client.complete({
        maxTokens: 32,
        messages: [{ content: 'Reply with a short greeting.', role: 'user' }],
        model: liveModels.anthropic,
        provider: 'anthropic',
        ...liveTemperature('anthropic', liveModels.anthropic),
      });

      expect(response.provider).toBe('anthropic');
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.usage.costUSD).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.GEMINI_API_KEY))(
    'completes a minimal request against Gemini',
    async () => {
      const client = LLMClient.fromEnv();
      const response = await client.complete({
        maxTokens: 32,
        messages: [{ content: 'Reply with a short greeting.', role: 'user' }],
        model: liveModels.gemini,
        provider: 'google',
        ...liveTemperature('google', liveModels.gemini),
      });

      expect(response.provider).toBe('google');
      expect(response.usage.costUSD).toBeGreaterThanOrEqual(0);
    },
  );

  liveIt(Boolean(process.env.OPENAI_API_KEY) && Boolean(process.env.DATABASE_URL))(
    'persists and restores a session through the default Postgres session store',
    async () => {
      const sessionId = `live_session_${Date.now()}`;
      const client = LLMClient.fromEnv({
        defaultModel: liveModels.openai,
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
