import { LLMClient, SlidingWindowStrategy } from '../dist/index.js';

const client = LLMClient.mock({
  defaultModel: 'mock-model',
  defaultProvider: 'mock',
});

const conversation = await client.conversation({
  contextManager: new SlidingWindowStrategy({
    maxMessages: 4,
  }),
  sessionId: 'memory-check-session',
});

const turns = 10_000;
const startHeapBytes = process.memoryUsage().heapUsed;

for (let turn = 0; turn < turns; turn += 1) {
  await conversation.send(`Turn ${turn}`);
}

const endHeapBytes = process.memoryUsage().heapUsed;
const heapDeltaBytes = endHeapBytes - startHeapBytes;
const historyCount = conversation.history.length;

console.log(
  JSON.stringify(
    {
      heapDeltaBytes,
      heapDeltaMB: Number((heapDeltaBytes / (1024 * 1024)).toFixed(2)),
      historyCount,
      maxAllowedHeapDeltaMB: 64,
      maxAllowedHistoryCount: 6,
      turns,
    },
    null,
    2,
  ),
);

if (historyCount > 6) {
  throw new Error(`Conversation history grew unexpectedly to ${historyCount} messages.`);
}

if (heapDeltaBytes > 64 * 1024 * 1024) {
  throw new Error(
    `Conversation memory delta exceeded 64MB (${(heapDeltaBytes / (1024 * 1024)).toFixed(2)}MB).`,
  );
}
