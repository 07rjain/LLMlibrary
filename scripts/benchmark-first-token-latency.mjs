import { performance } from 'node:perf_hooks';

import { LLMClient } from '../dist/index.js';

const samples = [];
const encoder = new TextEncoder();

const client = new LLMClient({
  defaultModel: 'gpt-4o',
  fetchImplementation: async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          queueMicrotask(() => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      delta: { content: 'benchmark', role: 'assistant' },
                      finish_reason: null,
                      index: 0,
                    },
                  ],
                  created: 1,
                  id: 'first_token_bench',
                  model: 'gpt-4o',
                  object: 'chat.completion.chunk',
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      delta: {},
                      finish_reason: 'stop',
                      index: 0,
                    },
                  ],
                  created: 1,
                  id: 'first_token_bench',
                  model: 'gpt-4o',
                  object: 'chat.completion.chunk',
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [],
                  created: 1,
                  id: 'first_token_bench',
                  model: 'gpt-4o',
                  object: 'chat.completion.chunk',
                  usage: {
                    completion_tokens: 1,
                    prompt_tokens: 4,
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          });
        },
      }),
      {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      },
    ),
  openaiApiKey: 'benchmark-key',
});

for (let iteration = 0; iteration < 100; iteration += 1) {
  const startedAt = performance.now();
  for await (const chunk of client.stream({
    messages: [{ content: 'Say benchmark.', role: 'user' }],
    model: 'gpt-4o',
    provider: 'openai',
  })) {
    if (chunk.type === 'text-delta') {
      samples.push(performance.now() - startedAt);
      break;
    }
  }
}

const sorted = [...samples].sort((left, right) => left - right);
const averageMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
const p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
const maxMs = sorted.at(-1) ?? 0;

console.log(
  JSON.stringify(
    {
      averageMs,
      maxMs,
      p95Ms,
      sampleCount: samples.length,
      thresholdMs: 10,
    },
    null,
    2,
  ),
);

if (p95Ms > 10) {
  throw new Error(
    `Streaming first-token latency p95 exceeded 10ms (${p95Ms.toFixed(3)}ms).`,
  );
}
