import { describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../src/errors.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import { GeminiAdapter } from '../src/providers/gemini.js';
import { OpenAIAdapter } from '../src/providers/openai.js';

import type { StreamChunk } from '../src/types.js';

const jsonHeaders = { 'content-type': 'application/json' };
const sseHeaders = { 'content-type': 'text/event-stream' };

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const chunk of stream) {
    void chunk;
  }
}

function expectSanitizedBoundary(error: unknown, operation: string): void {
  expect(error).toBeInstanceOf(ProviderError);
  expect(error).toMatchObject({
    details: {
      code: 'invalid_provider_response',
      operation,
    },
    retryable: false,
    statusCode: 502,
  });
  expect(JSON.stringify(error)).not.toContain('SECRET_PROVIDER_PAYLOAD');
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
}

describe('successful provider response boundaries', () => {
  it.each([
    [
      'OpenAI',
      () =>
        new OpenAIAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response('SECRET_PROVIDER_PAYLOAD', {
                headers: jsonHeaders,
                status: 200,
              }),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gpt-4o-mini',
        }),
    ],
    [
      'Anthropic',
      () =>
        new AnthropicAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response('SECRET_PROVIDER_PAYLOAD', {
                headers: jsonHeaders,
                status: 200,
              }),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'claude-haiku-4-5',
        }),
    ],
    [
      'Gemini',
      () =>
        new GeminiAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response('SECRET_PROVIDER_PAYLOAD', {
                headers: jsonHeaders,
                status: 200,
              }),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gemini-2.5-flash',
        }),
    ],
  ])('sanitizes malformed %s JSON', async (_provider, invoke) => {
    const error = await invoke().catch((caught: unknown) => caught);
    expectSanitizedBoundary(error, 'complete');
    expect(error).toMatchObject({
      details: { phase: 'json' },
    });
  });

  it.each([
    [
      'OpenAI',
      () =>
        new OpenAIAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response('{}', { headers: jsonHeaders, status: 200 }),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gpt-4o-mini',
        }),
    ],
    [
      'Anthropic',
      () =>
        new AnthropicAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response('{}', { headers: jsonHeaders, status: 200 }),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'claude-haiku-4-5',
        }),
    ],
    [
      'Gemini',
      () =>
        new GeminiAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response('{}', { headers: jsonHeaders, status: 200 }),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gemini-2.5-flash',
        }),
    ],
  ])('rejects malformed %s success schemas', async (_provider, invoke) => {
    const error = await invoke().catch((caught: unknown) => caught);
    expectSanitizedBoundary(error, 'complete');
    expect(error).toMatchObject({
      details: { phase: 'schema' },
    });
  });

  it.each([
    [
      'OpenAI',
      () =>
        new OpenAIAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  model: 'gpt-4o-mini',
                  output: [],
                  status: 'completed',
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
                { headers: jsonHeaders, status: 200 },
              ),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gpt-4o-mini',
        }),
    ],
    [
      'Anthropic',
      () =>
        new AnthropicAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  content: [],
                  model: 'claude-haiku-4-5',
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 1, output_tokens: 0 },
                }),
                { headers: jsonHeaders, status: 200 },
              ),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'claude-haiku-4-5',
        }),
    ],
    [
      'Gemini',
      () =>
        new GeminiAdapter({
          apiKey: 'test',
          fetchImplementation: vi.fn(async () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  candidates: [],
                  usageMetadata: {
                    candidatesTokenCount: 0,
                    promptTokenCount: 1,
                  },
                }),
                { headers: jsonHeaders, status: 200 },
              ),
            ),
          ),
        }).complete({
          maxTokens: 8,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'gemini-2.5-flash',
        }),
    ],
  ])(
    'rejects empty terminal %s success payloads',
    async (_provider, invoke) => {
      const error = await invoke().catch((caught: unknown) => caught);
      expectSanitizedBoundary(error, 'complete');
      expect(error).toMatchObject({
        details: {
          phase: 'schema',
          reason: 'invalid_provider_response',
        },
      });
    },
  );

  it('rejects a Gemini terminal candidate with empty content parts', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'test',
      fetchImplementation: vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [] },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
            }),
            { headers: jsonHeaders, status: 200 },
          ),
        ),
      ),
    });

    const error = await adapter
      .complete({
        maxTokens: 8,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-2.5-flash',
      })
      .catch((caught: unknown) => caught);

    expectSanitizedBoundary(error, 'complete');
    expect(error).toMatchObject({
      details: {
        path: 'candidates[0].content.parts',
        reason: 'invalid_provider_response',
      },
    });
  });

  it('rejects a Gemini complete response containing only private thoughts', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'test',
      fetchImplementation: vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: 'SECRET_THOUGHT_ONLY_COMPLETE',
                        thought: true,
                        thoughtSignature: 'secret-complete-signature',
                      },
                    ],
                  },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
              usageMetadata: { thoughtsTokenCount: 4 },
            }),
            { headers: jsonHeaders, status: 200 },
          ),
        ),
      ),
    });

    const error = await adapter
      .complete({
        maxTokens: 8,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-2.5-flash',
      })
      .catch((caught: unknown) => caught);

    expectSanitizedBoundary(error, 'complete');
    expect(error).toMatchObject({
      details: {
        path: 'candidates[0].content.parts',
        phase: 'schema',
        reason: 'invalid_provider_response',
      },
      provider: 'google',
    });
    expect(JSON.stringify(error)).not.toContain('SECRET_THOUGHT_ONLY_COMPLETE');
    expect(JSON.stringify(error)).not.toContain('secret-complete-signature');
  });

  it('rejects a successful response with the wrong content type', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test',
      fetchImplementation: vi.fn(async () =>
        Promise.resolve(
          new Response('{}', {
            headers: { 'content-type': 'text/html' },
            status: 200,
          }),
        ),
      ),
    });

    const error = await adapter
      .complete({
        maxTokens: 8,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gpt-4o-mini',
      })
      .catch((caught: unknown) => caught);

    expectSanitizedBoundary(error, 'complete');
    expect(error).toMatchObject({
      details: { contentType: 'text/html', phase: 'content-type' },
    });
  });

  it.each([
    [
      'OpenAI',
      () =>
        collect(
          new OpenAIAdapter({
            apiKey: 'test',
            fetchImplementation: vi.fn(async () =>
              Promise.resolve(
                new Response('', { headers: sseHeaders, status: 200 }),
              ),
            ),
          }).stream({
            maxTokens: 8,
            messages: [{ content: 'hello', role: 'user' }],
            model: 'gpt-4o-mini',
          }),
        ),
    ],
    [
      'Anthropic',
      () =>
        collect(
          new AnthropicAdapter({
            apiKey: 'test',
            fetchImplementation: vi.fn(async () =>
              Promise.resolve(
                new Response('', { headers: sseHeaders, status: 200 }),
              ),
            ),
          }).stream({
            maxTokens: 8,
            messages: [{ content: 'hello', role: 'user' }],
            model: 'claude-haiku-4-5',
          }),
        ),
    ],
    [
      'Gemini',
      () =>
        collect(
          new GeminiAdapter({
            apiKey: 'test',
            fetchImplementation: vi.fn(async () =>
              Promise.resolve(
                new Response('', { headers: sseHeaders, status: 200 }),
              ),
            ),
          }).stream({
            maxTokens: 8,
            messages: [{ content: 'hello', role: 'user' }],
            model: 'gemini-2.5-flash',
          }),
        ),
    ],
  ])('rejects empty/no-terminal %s streams', async (_provider, invoke) => {
    const error = await invoke().catch((caught: unknown) => caught);
    expectSanitizedBoundary(error, 'stream');
    expect(error).toMatchObject({
      details: { phase: 'stream' },
    });
  });

  it.each([
    [
      'OpenAI',
      () =>
        collect(
          new OpenAIAdapter({
            apiKey: 'test',
            fetchImplementation: vi.fn(async () =>
              Promise.resolve(
                new Response(
                  sse([
                    {
                      response: {
                        model: 'gpt-4o-mini',
                        output: [],
                        status: 'completed',
                        usage: { input_tokens: 1, output_tokens: 0 },
                      },
                      type: 'response.completed',
                    },
                  ]),
                  { headers: sseHeaders, status: 200 },
                ),
              ),
            ),
          }).stream({
            maxTokens: 8,
            messages: [{ content: 'hello', role: 'user' }],
            model: 'gpt-4o-mini',
          }),
        ),
    ],
    [
      'Anthropic',
      () =>
        collect(
          new AnthropicAdapter({
            apiKey: 'test',
            fetchImplementation: vi.fn(async () =>
              Promise.resolve(
                new Response(
                  sse([
                    {
                      message: {
                        content: [],
                        model: 'claude-haiku-4-5',
                        stop_reason: null,
                        usage: { input_tokens: 1, output_tokens: 0 },
                      },
                      type: 'message_start',
                    },
                    {
                      delta: { stop_reason: 'end_turn' },
                      type: 'message_delta',
                      usage: { output_tokens: 0 },
                    },
                    { type: 'message_stop' },
                  ]),
                  { headers: sseHeaders, status: 200 },
                ),
              ),
            ),
          }).stream({
            maxTokens: 8,
            messages: [{ content: 'hello', role: 'user' }],
            model: 'claude-haiku-4-5',
          }),
        ),
    ],
    [
      'Gemini',
      () =>
        collect(
          new GeminiAdapter({
            apiKey: 'test',
            fetchImplementation: vi.fn(async () =>
              Promise.resolve(
                new Response(
                  sse([
                    {
                      candidates: [
                        {
                          content: { parts: [] },
                          finishReason: 'STOP',
                          index: 0,
                        },
                      ],
                    },
                  ]),
                  { headers: sseHeaders, status: 200 },
                ),
              ),
            ),
          }).stream({
            maxTokens: 8,
            messages: [{ content: 'hello', role: 'user' }],
            model: 'gemini-2.5-flash',
          }),
        ),
    ],
  ])('rejects empty terminal %s stream payloads', async (_provider, invoke) => {
    const error = await invoke().catch((caught: unknown) => caught);
    expectSanitizedBoundary(error, 'stream');
    expect(error).toMatchObject({
      details: {
        reason: 'invalid_provider_response',
      },
    });
  });

  it('rejects a default Gemini stream containing only private thoughts', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'test',
      fetchImplementation: vi.fn(async () =>
        Promise.resolve(
          new Response(
            sse([
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: 'SECRET_THOUGHT_ONLY_STREAM',
                          thought: true,
                          thoughtSignature: 'secret-stream-signature',
                        },
                      ],
                    },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: { thoughtsTokenCount: 5 },
              },
            ]),
            { headers: sseHeaders, status: 200 },
          ),
        ),
      ),
    });

    const error = await collect(
      adapter.stream({
        maxTokens: 8,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-2.5-flash',
      }),
    ).catch((caught: unknown) => caught);

    expectSanitizedBoundary(error, 'stream');
    expect(error).toMatchObject({
      details: {
        path: 'candidates[0].content.parts',
        phase: 'stream',
        reason: 'invalid_provider_response',
      },
      provider: 'google',
    });
    expect(JSON.stringify(error)).not.toContain('SECRET_THOUGHT_ONLY_STREAM');
    expect(JSON.stringify(error)).not.toContain('secret-stream-signature');
  });
});
