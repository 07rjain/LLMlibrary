import { performance } from 'node:perf_hooks';

import { InMemorySessionStore, LLMClient } from '../dist/index.js';

const sessionStore = new InMemorySessionStore();
const client = LLMClient.mock({
  defaultModel: 'mock-model',
  defaultProvider: 'mock',
  sessionStore,
});

const concurrency = 100;
const startedAt = performance.now();
const results = await Promise.all(
  Array.from({ length: concurrency }, async (_, index) => {
    const sessionId = `concurrent-session-${index}`;
    const conversation = await client.conversation({ sessionId });
    const response = await conversation.send(`Session ${index}`);
    const restored = await client.conversation({ sessionId });
    return {
      messageCount: restored.toMessages().length,
      responseText: response.text,
      sessionId,
    };
  }),
);
const durationMs = performance.now() - startedAt;
const storedSessions = await sessionStore.list();

console.log(
  JSON.stringify(
    {
      concurrency,
      durationMs,
      restoredSessions: results.length,
      storedSessions: storedSessions.length,
    },
    null,
    2,
  ),
);

if (results.length !== concurrency) {
  throw new Error(`Expected ${concurrency} completed sessions, received ${results.length}.`);
}

if (storedSessions.length !== concurrency) {
  throw new Error(
    `Expected ${concurrency} stored sessions, found ${storedSessions.length}.`,
  );
}

if (results.some((result) => result.messageCount < 2)) {
  throw new Error('At least one concurrent session did not persist its transcript.');
}
