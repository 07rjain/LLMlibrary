import { performance } from 'node:perf_hooks';

import { LLMClient } from '../dist/index.js';

const samples = [];
let fetchStartedAt = 0;

const client = new LLMClient({
  defaultModel: 'gpt-4o',
  fetchImplementation: async () => {
    fetchStartedAt = performance.now();
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: {
              content: 'benchmark ok',
              role: 'assistant',
            },
          },
        ],
        created: 1,
        id: 'bench_1',
        model: 'gpt-4o',
        object: 'chat.completion',
        usage: {
          completion_tokens: 2,
          prompt_tokens: 4,
        },
      }),
      {
        headers: {
          'content-type': 'application/json',
        },
        status: 200,
      },
    );
  },
  openaiApiKey: 'benchmark-key',
});

for (let iteration = 0; iteration < 100; iteration += 1) {
  fetchStartedAt = 0;
  const startedAt = performance.now();
  await client.complete({
    messages: [{ content: 'Say benchmark ok.', role: 'user' }],
    model: 'gpt-4o',
    provider: 'openai',
  });
  samples.push(fetchStartedAt - startedAt);
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
      thresholdMs: 5,
    },
    null,
    2,
  ),
);

if (p95Ms > 5) {
  throw new Error(`llm.complete() overhead p95 exceeded 5ms (${p95Ms.toFixed(3)}ms).`);
}
