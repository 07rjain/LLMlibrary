import { describe, expect, it } from 'vitest';

import { parseSSE } from '../src/utils/parse-sse.js';

describe('parseSSE', () => {
  it('parses standard SSE payloads', async () => {
    const stream = makeStream(['data: first\n\n', 'data: second\n\n']);

    const chunks: string[] = [];
    for await (const payload of parseSSE(stream)) {
      chunks.push(payload);
    }

    expect(chunks).toEqual(['first', 'second']);
  });

  it('skips done sentinels and comment lines', async () => {
    const stream = makeStream([': ping\n', 'data: keep\n\n', 'data: [DONE]\n\n']);

    const chunks: string[] = [];
    for await (const payload of parseSSE(stream)) {
      chunks.push(payload);
    }

    expect(chunks).toEqual(['keep']);
  });

  it('supports multi-line payloads', async () => {
    const stream = makeStream(['data: first line\n', 'data: second line\n\n']);

    const chunks = await collect(parseSSE(stream));

    expect(chunks).toEqual(['first line\nsecond line']);
  });

  it('flushes buffered payloads when the stream closes without a sentinel', async () => {
    const stream = makeStream(['data: final payload']);

    const chunks = await collect(parseSSE(stream));

    expect(chunks).toEqual(['final payload']);
  });

  it('handles chunked unicode buffers safely', async () => {
    const encoder = new TextEncoder();
    const payload = encoder.encode('data: Привет\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.slice(0, 5));
        controller.enqueue(payload.slice(5));
        controller.close();
      },
    });

    const chunks = await collect(parseSSE(stream));

    expect(chunks).toEqual(['Привет']);
  });
});

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const value of iterable) {
    result.push(value);
  }

  return result;
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}
