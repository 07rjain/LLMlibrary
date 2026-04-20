import { describe, expect, it, vi } from 'vitest';

import { AnthropicAdapter } from '../src/providers/anthropic.js';
import { GeminiAdapter } from '../src/providers/gemini.js';
import { OpenAIAdapter } from '../src/providers/openai.js';
import { ModelRegistry } from '../src/models/registry.js';
import { AuthenticationError, ProviderError, RateLimitError } from '../src/errors.js';

import type { CanonicalMessage, StreamChunk } from '../src/types.js';

describe('Provider Adapters', () => {
  const modelRegistry = new ModelRegistry();

  describe('AnthropicAdapter', () => {
    it('should make complete request with correct headers', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [{ text: 'Hello from Claude!', type: 'text' }],
            id: 'msg_123',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new AnthropicAdapter({
        apiKey: 'test-anthropic-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      });

      expect(response.text).toBe('Hello from Claude!');
      expect(response.provider).toBe('anthropic');
      expect(response.model).toBe('claude-sonnet-4-6');

      const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('test-anthropic-key');
      expect(headers['anthropic-version']).toBeDefined();
    });

    it('should handle tool calls correctly', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            content: [
              { text: 'I will search for that', type: 'text' },
              {
                id: 'tool_call_1',
                input: { query: 'test query' },
                name: 'search',
                type: 'tool_use',
              },
            ],
            id: 'msg_123',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            stop_reason: 'tool_use',
            usage: { input_tokens: 15, output_tokens: 20 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new AnthropicAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Search for something', role: 'user' }],
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        tools: [
          {
            description: 'Search the web',
            name: 'search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      });

      expect(response.finishReason).toBe('tool_call');
      expect(response.toolCalls.length).toBe(1);
      expect(response.toolCalls[0]?.name).toBe('search');
      expect(response.toolCalls[0]?.args).toEqual({ query: 'test query' });
    });

    it('should stream responses correctly', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    content_block: { text: '', type: 'text' },
                    index: 0,
                    type: 'content_block_start',
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    delta: { text: 'Hello', type: 'text_delta' },
                    index: 0,
                    type: 'content_block_delta',
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    delta: { stop_reason: 'end_turn' },
                    type: 'message_delta',
                    usage: { output_tokens: 5 },
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' }, status: 200 },
        ),
      );

      const adapter = new AnthropicAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream({
        maxTokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      })) {
        chunks.push(chunk);
      }

      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
      expect(chunks.at(-1)?.type).toBe('done');
    });

    it('should throw AuthenticationError on 401', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          headers: { 'content-type': 'application/json' },
          status: 401,
        }),
      );

      const adapter = new AnthropicAdapter({
        apiKey: 'invalid-key',
        fetchImplementation: fetchMock,
        modelRegistry,
        retryOptions: { maxAttempts: 1 },
      });

      await expect(
        adapter.complete({
          maxTokens: 1024,
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
        }),
      ).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('should throw RateLimitError on 429', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
          status: 429,
        }),
      );

      const adapter = new AnthropicAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
        retryOptions: { maxAttempts: 1 },
      });

      await expect(
        adapter.complete({
          maxTokens: 1024,
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
        }),
      ).rejects.toBeInstanceOf(RateLimitError);
    });
  });

  describe('OpenAIAdapter', () => {
    it('should make complete request with correct headers', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'resp_123',
            model: 'gpt-4o',
            object: 'response',
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: 'Hello from GPT!',
                    type: 'output_text',
                  },
                ],
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                type: 'message',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new OpenAIAdapter({
        apiKey: 'test-openai-key',
        fetchImplementation: fetchMock,
        modelRegistry,
        organization: 'test-org',
        project: 'test-project',
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-4o',
        provider: 'openai',
      });

      expect(response.text).toBe('Hello from GPT!');
      expect(response.provider).toBe('openai');

      const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-openai-key');
      expect(headers['OpenAI-Organization']).toBe('test-org');
      expect(headers['OpenAI-Project']).toBe('test-project');
    });

    it('should handle tool calls correctly', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'resp_123',
            model: 'gpt-4o',
            object: 'response',
            output: [
              {
                arguments: '{"query":"test"}',
                call_id: 'call_123',
                id: 'fc_1',
                name: 'search',
                status: 'completed',
                type: 'function_call',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 20, output_tokens: 15 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new OpenAIAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Search for something', role: 'user' }],
        model: 'gpt-4o',
        provider: 'openai',
        tools: [
          {
            description: 'Search the web',
            name: 'search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      });

      expect(response.finishReason).toBe('tool_call');
      expect(response.toolCalls.length).toBe(1);
      expect(response.toolCalls[0]?.name).toBe('search');
    });

    it('should stream responses correctly', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    content_index: 0,
                    delta: 'Hello',
                    item_id: 'msg_1',
                    output_index: 0,
                    sequence_number: 1,
                    type: 'response.output_text.delta',
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    response: {
                      id: 'resp_1',
                      model: 'gpt-4o',
                      object: 'response',
                      output: [
                        {
                          content: [
                            {
                              annotations: [],
                              text: 'Hello',
                              type: 'output_text',
                            },
                          ],
                          id: 'msg_1',
                          role: 'assistant',
                          status: 'completed',
                          type: 'message',
                        },
                      ],
                      status: 'completed',
                      usage: { input_tokens: 10, output_tokens: 5 },
                    },
                    sequence_number: 2,
                    type: 'response.completed',
                  })}\n\n`,
                ),
              );
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' }, status: 200 },
        ),
      );

      const adapter = new OpenAIAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream({
        maxTokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-4o',
        provider: 'openai',
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ delta: 'Hello', type: 'text-delta' });
      expect(chunks.at(-1)?.type).toBe('done');
    });

    it('should handle system messages correctly', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            model: 'gpt-4o',
            object: 'response',
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: 'OK',
                    type: 'output_text',
                  },
                ],
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                type: 'message',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 15, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new OpenAIAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-4o',
        provider: 'openai',
        system: 'You are helpful',
      });

      const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
      const body = JSON.parse(init.body as string) as { instructions?: string; input: CanonicalMessage[] };
      expect(body.instructions).toBe('You are helpful');
    });
  });

  describe('GeminiAdapter', () => {
    it('should make complete request with correct URL and key', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Hello from Gemini!' }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: { candidatesTokenCount: 5, promptTokenCount: 10 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new GeminiAdapter({
        apiKey: 'test-gemini-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gemini-2.5-flash',
        provider: 'google',
      });

      expect(response.text).toBe('Hello from Gemini!');
      expect(response.provider).toBe('google');

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('generativelanguage.googleapis.com');
    });

    it('should handle tool calls correctly', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        args: { query: 'test' },
                        name: 'search',
                      },
                    },
                  ],
                  role: 'model',
                },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: { candidatesTokenCount: 10, promptTokenCount: 15 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new GeminiAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Search', role: 'user' }],
        model: 'gemini-2.5-flash',
        provider: 'google',
        tools: [
          {
            description: 'Search',
            name: 'search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      });

      expect(response.toolCalls.length).toBe(1);
      expect(response.toolCalls[0]?.name).toBe('search');
    });

    it('should stream responses correctly', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    candidates: [
                      {
                        content: { parts: [{ text: 'Hello' }], role: 'model' },
                        index: 0,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    candidates: [
                      {
                        content: { parts: [{ text: ' World' }], role: 'model' },
                        finishReason: 'STOP',
                        index: 0,
                      },
                    ],
                    usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 5 },
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' }, status: 200 },
        ),
      );

      const adapter = new GeminiAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of adapter.stream({
        maxTokens: 1024,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gemini-2.5-flash',
        provider: 'google',
      })) {
        chunks.push(chunk);
      }

      expect(chunks.filter((c) => c.type === 'text-delta').length).toBeGreaterThan(0);
      expect(chunks.at(-1)?.type).toBe('done');
    });

    it('should handle Gemini-specific finish reasons', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Filtered' }], role: 'model' },
                finishReason: 'SAFETY',
                index: 0,
              },
            ],
            usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 5 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new GeminiAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [{ content: 'Test', role: 'user' }],
        model: 'gemini-2.5-flash',
        provider: 'google',
      });

      expect(response.finishReason).toBe('content_filter');
    });

    it('should throw ProviderError on 500', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Internal error' } }), {
          headers: { 'content-type': 'application/json' },
          status: 500,
        }),
      );

      const adapter = new GeminiAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
        retryOptions: { maxAttempts: 1 },
      });

      await expect(
        adapter.complete({
          maxTokens: 1024,
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'gemini-2.5-flash',
          provider: 'google',
        }),
      ).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe('Message Format Conversion', () => {
    it('should handle multipart content', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            model: 'gpt-4o',
            object: 'response',
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: 'OK',
                    type: 'output_text',
                  },
                ],
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                type: 'message',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 20, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new OpenAIAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [
          {
            content: [
              { text: 'Look at this image:', type: 'text' },
              { type: 'image_url', url: 'https://example.com/image.png' },
            ],
            role: 'user',
          },
        ],
        model: 'gpt-4o',
        provider: 'openai',
      });

      expect(response.text).toBe('OK');
    });

    it('should handle tool results', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            model: 'gpt-4o',
            object: 'response',
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: 'Done',
                    type: 'output_text',
                  },
                ],
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                type: 'message',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 25, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const adapter = new OpenAIAdapter({
        apiKey: 'test-key',
        fetchImplementation: fetchMock,
        modelRegistry,
      });

      const response = await adapter.complete({
        maxTokens: 1024,
        messages: [
          { content: 'Search', role: 'user' },
          {
            content: [
              { args: { query: 'test' }, id: 'call_1', name: 'search', type: 'tool_call' },
            ],
            role: 'assistant',
          },
          {
            content: [
              { isError: false, result: { data: 'result' }, toolCallId: 'call_1', type: 'tool_result' },
            ],
            role: 'user',
          },
        ],
        model: 'gpt-4o',
        provider: 'openai',
      });

      expect(response.text).toBe('Done');
    });
  });
});
