import { describe, expect, it, vi } from 'vitest';

import {
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import {
  AnthropicAdapter,
  mapAnthropicError,
  translateAnthropicRequest,
  translateAnthropicResponse,
  translateAnthropicToolChoice,
} from '../src/providers/anthropic.js';

describe('Anthropic adapter', () => {
  it('translates canonical requests into Anthropic payloads', () => {
    const request = translateAnthropicRequest({
      maxTokens: 256,
      messages: [
        { content: 'You are helpful.', role: 'system' },
        {
          content: [
            { cacheControl: { type: 'ephemeral' }, text: 'Hello', type: 'text' },
            { type: 'image_url', url: 'https://example.com/cat.png' },
          ],
          role: 'user',
        },
        {
          content: [
            {
              args: { city: 'Berlin' },
              id: 'tool_1',
              name: 'weather_lookup',
              type: 'tool_call',
            },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              result: { temperature: 18 },
              toolCallId: 'tool_1',
              type: 'tool_result',
            },
          ],
          role: 'user',
        },
      ],
      model: 'claude-sonnet-4-6',
      toolChoice: { type: 'tool', name: 'weather_lookup' },
      tools: [
        {
          description: 'Look up weather.',
          name: 'weather_lookup',
          parameters: {
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
            type: 'object',
          },
        },
      ],
    });

    expect(request).toMatchObject({
      max_tokens: 256,
      model: 'claude-sonnet-4-6',
      system: 'You are helpful.',
      tool_choice: { name: 'weather_lookup', type: 'tool' },
    });
    expect(request.tools).toHaveLength(1);
    expect(request.messages).toMatchObject([
      {
        content: [
          { text: 'Hello', type: 'text' },
          { source: { type: 'url', url: 'https://example.com/cat.png' }, type: 'image' },
        ],
        role: 'user',
      },
      {
        content: [
          {
            id: 'tool_1',
            input: { city: 'Berlin' },
            name: 'weather_lookup',
            type: 'tool_use',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            content: '{"temperature":18}',
            tool_use_id: 'tool_1',
            type: 'tool_result',
          },
        ],
        role: 'user',
      },
    ]);
  });

  it('translates tool choices', () => {
    expect(translateAnthropicToolChoice({ type: 'auto' })).toEqual({
      type: 'auto',
    });
  });

  it('maps top-level Anthropic cache control options into requests', () => {
    const request = translateAnthropicRequest({
      maxTokens: 64,
      messages: [{ content: 'Hi', role: 'user' }],
      model: 'claude-sonnet-4-6',
      providerOptions: {
        anthropic: {
          cacheControl: {
            ttl: '1h',
            type: 'ephemeral',
          },
        },
      },
    });

    expect(request).toMatchObject({
      cache_control: {
        ttl: '1h',
        type: 'ephemeral',
      },
    });
  });

  it('maps cache_control onto cacheable Anthropic content blocks and tool definitions', () => {
    const request = translateAnthropicRequest({
      maxTokens: 64,
      messages: [
        {
          content: [
            {
              cacheControl: { type: 'ephemeral' },
              type: 'image_url',
              url: 'https://example.com/image.png',
            },
            {
              cacheControl: { ttl: '5m', type: 'ephemeral' },
              mediaType: 'application/pdf',
              type: 'document',
              url: 'https://example.com/doc.pdf',
            },
          ],
          role: 'user',
        },
        {
          content: [
            {
              args: { city: 'Berlin' },
              cacheControl: { type: 'ephemeral' },
              id: 'tool_1',
              name: 'weather_lookup',
              type: 'tool_call',
            },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              cacheControl: { ttl: '5m', type: 'ephemeral' },
              result: { temperature: 18 },
              toolCallId: 'tool_1',
              type: 'tool_result',
            },
          ],
          role: 'user',
        },
      ],
      model: 'claude-sonnet-4-6',
      tools: [
        {
          cacheControl: { type: 'ephemeral' },
          description: 'Look up weather.',
          name: 'weather_lookup',
          parameters: {
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
            type: 'object',
          },
        },
      ],
    });

    expect(request.tools).toEqual([
      {
        cache_control: { type: 'ephemeral' },
        description: 'Look up weather.',
        input_schema: {
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
          type: 'object',
        },
        name: 'weather_lookup',
      },
    ]);
    expect(request.messages).toMatchObject([
      {
        content: [
          {
            cache_control: { type: 'ephemeral' },
            source: { type: 'url', url: 'https://example.com/image.png' },
            type: 'image',
          },
          {
            cache_control: { ttl: '5m', type: 'ephemeral' },
            source: { type: 'url', url: 'https://example.com/doc.pdf' },
            type: 'document',
          },
        ],
      },
      {
        content: [
          {
            cache_control: { type: 'ephemeral' },
            id: 'tool_1',
            input: { city: 'Berlin' },
            name: 'weather_lookup',
            type: 'tool_use',
          },
        ],
      },
      {
        content: [
          {
            cache_control: { ttl: '5m', type: 'ephemeral' },
            content: '{"temperature":18}',
            tool_use_id: 'tool_1',
            type: 'tool_result',
          },
        ],
      },
    ]);
  });

  it('keeps cached system prompts as Anthropic system blocks', () => {
    const request = translateAnthropicRequest({
      maxTokens: 64,
      messages: [
        {
          content: [
            {
              cacheControl: { type: 'ephemeral' },
              text: 'Pinned instructions',
              type: 'text',
            },
          ],
          role: 'system',
        },
        { content: 'Hi', role: 'user' },
      ],
      model: 'claude-sonnet-4-6',
    });

    expect(request.system).toEqual([
      {
        cache_control: { type: 'ephemeral' },
        text: 'Pinned instructions',
        type: 'text',
      },
    ]);
  });

  it('rejects non-text Anthropic system prompt parts', () => {
    expect(() =>
      translateAnthropicRequest({
        maxTokens: 64,
        messages: [
          {
            content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
            role: 'system',
          },
          { content: 'Hi', role: 'user' },
        ],
        model: 'claude-sonnet-4-6',
      }),
    ).toThrow(ProviderCapabilityError);
  });

  it('translates Anthropic responses into canonical responses', () => {
    const response = translateAnthropicResponse({
      content: [
        { text: 'Checking.', type: 'text' },
        {
          id: 'tool_1',
          input: { city: 'Berlin' },
          name: 'weather_lookup',
          type: 'tool_use',
        },
      ],
      id: 'msg_1',
      model: 'claude-sonnet-4-6',
      role: 'assistant',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
      },
    });

    expect(response).toMatchObject({
      finishReason: 'tool_call',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      text: 'Checking.',
      toolCalls: [
        {
          args: { city: 'Berlin' },
          id: 'tool_1',
          name: 'weather_lookup',
        },
      ],
    });
  });

  it('falls back to the requested model when Anthropic returns a versioned model id', () => {
    const response = translateAnthropicResponse(
      {
        content: [{ text: 'Hello', type: 'text' }],
        id: 'msg_2',
        model: 'claude-haiku-4-5-20251001',
        role: 'assistant',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 8,
          output_tokens: 4,
        },
      },
      new ModelRegistry(),
      'claude-haiku-4-5',
    );

    expect(response.model).toBe('claude-haiku-4-5');
    expect(response.usage.inputTokens).toBe(8);
  });

  it('normalizes non-tool finish reasons', () => {
    expect(
      translateAnthropicResponse({
        content: [{ text: 'Truncated', type: 'text' }],
        id: 'msg_2',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 5 },
      }).finishReason,
    ).toBe('length');

    expect(
      translateAnthropicResponse({
        content: [{ text: 'Stopped', type: 'text' }],
        id: 'msg_3',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 10, output_tokens: 5 },
      }).finishReason,
    ).toBe('stop');
  });

  it('maps Anthropic API errors into typed errors', async () => {
    const authError = await mapAnthropicError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Invalid API key',
            type: 'authentication_error',
          },
        }),
        {
          headers: { 'anthropic-request-id': 'req_auth' },
          status: 401,
        },
      ),
      'claude-sonnet-4-6',
    );
    const contextError = await mapAnthropicError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Prompt exceeds the context window',
            type: 'invalid_request_error',
          },
        }),
        {
          status: 400,
        },
      ),
      'claude-sonnet-4-6',
    );

    expect(authError.name).toBe('AuthenticationError');
    expect(authError.requestId).toBe('req_auth');
    expect(contextError.name).toBe('ContextLimitError');
  });

  it('maps rate-limit and generic provider errors', async () => {
    const rateLimitError = await mapAnthropicError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Slow down',
            type: 'rate_limit_error',
          },
        }),
        {
          status: 429,
        },
      ),
      'claude-sonnet-4-6',
    );
    const providerError = await mapAnthropicError(
      new Response('not-json', {
        status: 529,
      }),
      undefined,
    );

    expect(rateLimitError).toBeInstanceOf(RateLimitError);
    expect(providerError).toBeInstanceOf(ProviderError);
  });

  it('performs a complete Anthropic request with auth headers', async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ text: 'Hello there', type: 'text' }],
          id: 'msg_1',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      ),
    );

    const adapter = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      fetchImplementation,
    });
    const result = await adapter.complete({
      maxTokens: 128,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'claude-sonnet-4-6',
    });
    const request = fetchImplementation.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    expect(result.text).toBe('Hello there');
    expect(request[0]).toContain('/v1/messages');
    expect((request[1].headers as Record<string, string>)['x-api-key']).toBe(
      'anthropic-key',
    );
  });

  it('throws a typed rate-limit error from complete()', async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Too many requests',
            type: 'rate_limit_error',
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 429,
        },
      ),
    );
    const adapter = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      fetchImplementation,
      retryOptions: {
        jitterMs: 0,
        maxAttempts: 1,
      },
    });

    await expect(
      adapter.complete({
        maxTokens: 128,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'claude-sonnet-4-6',
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('rejects unsupported audio, tools, vision, and streaming capabilities before fetch', async () => {
    const registry = new ModelRegistry();
    registry.register({
      contextWindow: 32000,
      id: 'mock-no-capabilities',
      inputPrice: 1,
      lastUpdated: '2026-04-15',
      outputPrice: 2,
      provider: 'mock',
      supportsStreaming: false,
      supportsTools: false,
      supportsVision: false,
    });
    const fetchImplementation = vi.fn();
    const adapter = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      fetchImplementation,
      modelRegistry: registry,
    });

    await expect(
      adapter.complete({
        maxTokens: 64,
        messages: [
          {
            content: [{ data: 'audio', mediaType: 'audio/wav', type: 'audio' }],
            role: 'user',
          },
        ],
        model: 'mock-no-capabilities',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.complete({
        maxTokens: 64,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'mock-no-capabilities',
        tools: [
          {
            description: 'Lookup',
            name: 'lookup',
            parameters: { type: 'object' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.complete({
        maxTokens: 64,
        messages: [
          {
            content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
            role: 'user',
          },
        ],
        model: 'mock-no-capabilities',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.stream({
        maxTokens: 64,
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'mock-no-capabilities',
      }).next(),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('streams text and tool-call events', async () => {
    const stream = makeSSEStream([
      {
        message: {
          content: [],
          id: 'msg_1',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          stop_reason: null,
          usage: {
            input_tokens: 100,
            output_tokens: 0,
          },
        },
        type: 'message_start',
      },
      {
        content_block: {
          id: 'tool_1',
          input: {},
          name: 'weather_lookup',
          type: 'tool_use',
        },
        index: 0,
        type: 'content_block_start',
      },
      {
        delta: {
          partial_json: '{"city":"Ber',
          type: 'input_json_delta',
        },
        index: 0,
        type: 'content_block_delta',
      },
      {
        delta: {
          partial_json: 'lin"}',
          type: 'input_json_delta',
        },
        index: 0,
        type: 'content_block_delta',
      },
      {
        index: 0,
        type: 'content_block_stop',
      },
      {
        delta: {
          stop_reason: 'tool_use',
        },
        type: 'message_delta',
        usage: {
          output_tokens: 22,
        },
      },
      {
        type: 'message_stop',
      },
    ]);
    const fetchImplementation = vi.fn(async () =>
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      }),
    );
    const adapter = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      fetchImplementation,
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      maxTokens: 128,
      messages: [{ content: 'Check the weather', role: 'user' }],
      model: 'claude-sonnet-4-6',
      tools: [
        {
          description: 'Look up weather.',
          name: 'weather_lookup',
          parameters: {
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
            type: 'object',
          },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { id: 'tool_1', name: 'weather_lookup', type: 'tool-call-start' },
      { argsDelta: '{"city":"Ber', id: 'tool_1', type: 'tool-call-delta' },
      { argsDelta: 'lin"}', id: 'tool_1', type: 'tool-call-delta' },
      {
        id: 'tool_1',
        name: 'weather_lookup',
        result: { city: 'Berlin' },
        type: 'tool-call-result',
      },
      expect.objectContaining({
        finishReason: 'tool_call',
        type: 'done',
      }),
    ]);
  });

  it('streams text deltas and throws when the stream body is missing', async () => {
    const textStream = makeSSEStream([
      {
        message: {
          content: [],
          id: 'msg_text',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          stop_reason: null,
          usage: {
            input_tokens: 50,
            output_tokens: 0,
          },
        },
        type: 'message_start',
      },
      {
        content_block: {
          text: '',
          type: 'text',
        },
        index: 0,
        type: 'content_block_start',
      },
      {
        delta: {
          text: 'Hello ',
          type: 'text_delta',
        },
        index: 0,
        type: 'content_block_delta',
      },
      {
        delta: {
          text: 'world',
          type: 'text_delta',
        },
        index: 0,
        type: 'content_block_delta',
      },
      {
        delta: {
          stop_reason: 'end_turn',
        },
        type: 'message_delta',
        usage: {
          output_tokens: 12,
        },
      },
      {
        type: 'message_stop',
      },
    ]);
    const adapter = new AnthropicAdapter({
      apiKey: 'anthropic-key',
      fetchImplementation: vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(
          new Response(textStream, {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 })),
    });

    const textChunks = [];
    for await (const chunk of adapter.stream({
      maxTokens: 128,
      messages: [{ content: 'Say hello', role: 'user' }],
      model: 'claude-sonnet-4-6',
    })) {
      textChunks.push(chunk);
    }

    expect(textChunks).toEqual([
      { delta: 'Hello ', type: 'text-delta' },
      { delta: 'world', type: 'text-delta' },
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    ]);

    await expect(
      adapter.stream({
        maxTokens: 128,
        messages: [{ content: 'Say hello', role: 'user' }],
        model: 'claude-sonnet-4-6',
      }).next(),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

function makeSSEStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}
