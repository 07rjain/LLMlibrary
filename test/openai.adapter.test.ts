import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import {
  OpenAIAdapter,
  mapOpenAIError,
  translateOpenAIRequest,
  translateOpenAIResponse,
  translateOpenAIToolChoice,
} from '../src/providers/openai.js';

describe('OpenAI adapter', () => {
  it('translates canonical requests into Responses payloads', () => {
    const request = translateOpenAIRequest({
      maxTokens: 256,
      messages: [
        { content: 'You are helpful.', role: 'system' },
        {
          content: [
            { text: 'Hello', type: 'text' },
            { type: 'image_url', url: 'https://example.com/cat.png' },
          ],
          role: 'user',
        },
        {
          content: [
            {
              args: { city: 'Berlin' },
              id: 'call_1',
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
              toolCallId: 'call_1',
              type: 'tool_result',
            },
          ],
          role: 'user',
        },
      ],
      model: 'gpt-4o',
      system: 'Pinned system',
      toolChoice: {
        disableParallelToolUse: true,
        name: 'weather_lookup',
        type: 'tool',
      },
      tools: [
        {
          description: 'Lookup weather',
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
      instructions: 'Pinned system\n\nYou are helpful.',
      max_output_tokens: 256,
      model: 'gpt-4o',
      parallel_tool_calls: false,
      store: false,
      tool_choice: {
        name: 'weather_lookup',
        type: 'function',
      },
      tools: [
        {
          description: 'Lookup weather',
          name: 'weather_lookup',
          strict: false,
          type: 'function',
        },
      ],
    });
    expect(request.input).toEqual([
      {
        content: [
          { text: 'Hello', type: 'input_text' },
          {
            image_url: 'https://example.com/cat.png',
            type: 'input_image',
          },
        ],
        role: 'user',
        type: 'message',
      },
      {
        arguments: '{"city":"Berlin"}',
        call_id: 'call_1',
        name: 'weather_lookup',
        type: 'function_call',
      },
      {
        call_id: 'call_1',
        output: '{"temperature":18}',
        type: 'function_call_output',
      },
    ]);
  });

  it('maps tool choice aliases', () => {
    expect(translateOpenAIToolChoice({ type: 'any' })).toEqual({
      toolChoice: 'required',
    });
    expect(translateOpenAIToolChoice({ type: 'auto' })).toEqual({
      toolChoice: 'auto',
    });
  });

  it('translates Responses payloads into canonical responses', () => {
    const response = translateOpenAIResponse({
      id: 'resp_1',
      model: 'gpt-4o',
      object: 'response',
      output: [
        {
          content: [
            {
              annotations: [],
              text: 'Checking.',
              type: 'output_text',
            },
          ],
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          type: 'message',
        },
        {
          arguments: '{"city":"Berlin"}',
          call_id: 'call_1',
          id: 'fc_1',
          name: 'weather_lookup',
          status: 'completed',
          type: 'function_call',
        },
      ],
      status: 'completed',
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens: 12,
      },
    });

    expect(response).toMatchObject({
      finishReason: 'tool_call',
      model: 'gpt-4o',
      provider: 'openai',
      text: 'Checking.',
      toolCalls: [
        {
          args: { city: 'Berlin' },
          id: 'call_1',
          name: 'weather_lookup',
        },
      ],
    });
    expect(response.usage.cachedReadTokens).toBe(10);
    expect(response.usage.inputTokens).toBe(40);
  });

  it('falls back to the requested model when OpenAI returns a versioned model id', () => {
    const response = translateOpenAIResponse(
      {
        id: 'resp_1',
        model: 'gpt-4o-2024-08-06',
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
        usage: {
          input_tokens: 8,
          output_tokens: 4,
        },
      },
      new ModelRegistry(),
      'gpt-4o',
    );

    expect(response.model).toBe('gpt-4o');
    expect(response.usage.inputTokens).toBe(8);
  });

  it('throws if a response has invalid tool arguments', () => {
    expect(() =>
      translateOpenAIResponse({
        id: 'resp_1',
        model: 'gpt-4o',
        object: 'response',
        output: [
          {
            arguments: 'not-json',
            call_id: 'call_1',
            id: 'fc_1',
            name: 'weather_lookup',
            status: 'completed',
            type: 'function_call',
          },
        ],
        status: 'completed',
      }),
    ).toThrow(ProviderError);
  });

  it('maps OpenAI API errors into typed errors', async () => {
    const authError = await mapOpenAIError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Bad key',
            type: 'authentication_error',
          },
        }),
        {
          headers: { 'x-request-id': 'req_auth' },
          status: 401,
        },
      ),
      'gpt-4o',
    );
    const contextError = await mapOpenAIError(
      new Response(
        JSON.stringify({
          error: {
            code: 'context_length_exceeded',
            message: 'Context too long',
            type: 'invalid_request_error',
          },
        }),
        {
          status: 400,
        },
      ),
      'gpt-4o',
    );
    const rateLimitError = await mapOpenAIError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Too many requests',
            type: 'rate_limit_error',
          },
        }),
        {
          status: 429,
        },
      ),
      'gpt-4o',
    );

    expect(authError).toBeInstanceOf(AuthenticationError);
    expect(authError.requestId).toBe('req_auth');
    expect(contextError).toBeInstanceOf(ContextLimitError);
    expect(rateLimitError).toBeInstanceOf(RateLimitError);
  });

  it('maps generic provider errors on invalid JSON bodies', async () => {
    const providerError = await mapOpenAIError(
      new Response('not-json', {
        status: 500,
      }),
      undefined,
    );

    expect(providerError).toBeInstanceOf(ProviderError);
  });

  it('performs a complete request with auth headers', async () => {
    const signal = new AbortController().signal;
    const fetchImplementation = vi.fn(async () =>
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
                  text: 'Hello there',
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
          usage: {
            input_tokens: 20,
            output_tokens: 10,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      ),
    );
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation,
      organization: 'org_123',
      project: 'proj_123',
    });

    const result = await adapter.complete({
      maxTokens: 128,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
      signal,
    });
    const request = fetchImplementation.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = request[1].headers as Record<string, string>;

    expect(result.text).toBe('Hello there');
    expect(request[0]).toContain('/v1/responses');
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      max_output_tokens: 128,
      model: 'gpt-4o',
      store: false,
    });
    expect(headers.Authorization).toBe('Bearer openai-key');
    expect(headers['OpenAI-Organization']).toBe('org_123');
    expect(headers['OpenAI-Project']).toBe('proj_123');
    expect(request[1].signal).toBe(signal);
  });

  it('streams text deltas and done events', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(async () =>
        new Response(
          makeSSEStream([
            {
              content_index: 0,
              delta: 'Hello ',
              item_id: 'msg_1',
              output_index: 0,
              sequence_number: 1,
              type: 'response.output_text.delta',
            },
            {
              content_index: 0,
              delta: 'world',
              item_id: 'msg_1',
              output_index: 0,
              sequence_number: 2,
              type: 'response.output_text.delta',
            },
            {
              response: {
                id: 'resp_1',
                model: 'gpt-4o',
                object: 'response',
                output: [
                  {
                    content: [
                      {
                        annotations: [],
                        text: 'Hello world',
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
                usage: {
                  input_tokens: 20,
                  output_tokens: 12,
                },
              },
              sequence_number: 3,
              type: 'response.completed',
            },
          ]),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      maxTokens: 128,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: 'Hello ', type: 'text-delta' },
      { delta: 'world', type: 'text-delta' },
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    ]);
  });

  it('streams tool-call deltas and reassembles arguments', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(async () =>
        new Response(
          makeSSEStream([
            {
              item: {
                arguments: '',
                call_id: 'call_1',
                id: 'fc_1',
                name: 'weather_lookup',
                status: 'in_progress',
                type: 'function_call',
              },
              output_index: 0,
              sequence_number: 1,
              type: 'response.output_item.added',
            },
            {
              delta: '{"city":"Ber',
              item_id: 'fc_1',
              output_index: 0,
              sequence_number: 2,
              type: 'response.function_call_arguments.delta',
            },
            {
              delta: 'lin"}',
              item_id: 'fc_1',
              output_index: 0,
              sequence_number: 3,
              type: 'response.function_call_arguments.delta',
            },
            {
              arguments: '{"city":"Berlin"}',
              call_id: 'call_1',
              item_id: 'fc_1',
              name: 'weather_lookup',
              output_index: 0,
              sequence_number: 4,
              type: 'response.function_call_arguments.done',
            },
            {
              item: {
                arguments: '{"city":"Berlin"}',
                call_id: 'call_1',
                id: 'fc_1',
                name: 'weather_lookup',
                status: 'completed',
                type: 'function_call',
              },
              output_index: 0,
              sequence_number: 5,
              type: 'response.output_item.done',
            },
            {
              response: {
                id: 'resp_tool_1',
                model: 'gpt-4o',
                object: 'response',
                output: [
                  {
                    arguments: '{"city":"Berlin"}',
                    call_id: 'call_1',
                    id: 'fc_1',
                    name: 'weather_lookup',
                    status: 'completed',
                    type: 'function_call',
                  },
                ],
                status: 'completed',
                usage: {
                  input_tokens: 20,
                  output_tokens: 12,
                },
              },
              sequence_number: 6,
              type: 'response.completed',
            },
          ]),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      maxTokens: 128,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
      tools: [
        {
          description: 'Lookup weather',
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
      { id: 'call_1', name: 'weather_lookup', type: 'tool-call-start' },
      { argsDelta: '{"city":"Ber', id: 'call_1', type: 'tool-call-delta' },
      { argsDelta: 'lin"}', id: 'call_1', type: 'tool-call-delta' },
      {
        id: 'call_1',
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

  it('rejects unsupported parts and missing stream bodies', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response(null, { status: 200 })),
    });

    await expect(
      adapter.complete({
        messages: [
          {
            content: [{ data: 'pdf', mediaType: 'application/pdf', type: 'document' }],
            role: 'user',
          },
        ],
        model: 'gpt-4o',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.complete({
        messages: [
          {
            content: [
              {
                args: { city: 'Berlin' },
                id: 'call_1',
                name: 'weather_lookup',
                type: 'tool_call',
              },
            ],
            role: 'user',
          },
        ],
        model: 'gpt-4o',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.complete({
        messages: [
          {
            content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
            role: 'assistant',
          },
        ],
        model: 'gpt-4o',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.stream({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'gpt-4o',
      }).next(),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('normalizes incomplete and failed finish reasons', () => {
    expect(
      translateOpenAIResponse({
        id: 'resp_len',
        incomplete_details: { reason: 'max_output_tokens' },
        model: 'gpt-4o',
        object: 'response',
        output: [],
        status: 'incomplete',
      }).finishReason,
    ).toBe('length');

    expect(
      translateOpenAIResponse({
        id: 'resp_filter',
        incomplete_details: { reason: 'content_filter' },
        model: 'gpt-4o',
        object: 'response',
        output: [],
        status: 'incomplete',
      }).finishReason,
    ).toBe('content_filter');

    expect(
      translateOpenAIResponse({
        error: { message: 'failed' },
        id: 'resp_error',
        model: 'gpt-4o',
        object: 'response',
        output: [],
        status: 'failed',
      }).finishReason,
    ).toBe('error');
  });

  it('ignores reasoning items in Responses output for parity', () => {
    const response = translateOpenAIResponse({
      id: 'resp_reasoning',
      model: 'gpt-4o',
      object: 'response',
      output: [
        {
          id: 'rs_1',
          summary: [
            { text: 'Thinking...', type: 'summary_text' },
          ],
          type: 'reasoning',
        },
        {
          content: [
            {
              annotations: [],
              text: 'The answer is 42.',
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
      usage: {
        input_tokens: 50,
        output_tokens: 20,
      },
    });

    expect(response.text).toBe('The answer is 42.');
    expect(response.content).toEqual([{ text: 'The answer is 42.', type: 'text' }]);
    expect(response.toolCalls).toEqual([]);
  });

  it('translates image_base64 canonical parts to Responses input_image', () => {
    const request = translateOpenAIRequest({
      messages: [
        {
          content: [
            {
              data: 'iVBORw0KGgo=',
              mediaType: 'image/png',
              type: 'image_base64',
            },
          ],
          role: 'user',
        },
      ],
      model: 'gpt-4o',
    });

    expect(request.input).toEqual([
      {
        content: [
          {
            image_url: 'data:image/png;base64,iVBORw0KGgo=',
            type: 'input_image',
          },
        ],
        role: 'user',
        type: 'message',
      },
    ]);
  });

  it('translates multiple tool calls in one Responses output', () => {
    const response = translateOpenAIResponse({
      id: 'resp_multi_tool',
      model: 'gpt-4o',
      object: 'response',
      output: [
        {
          content: [
            {
              annotations: [],
              text: 'Looking up both.',
              type: 'output_text',
            },
          ],
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          type: 'message',
        },
        {
          arguments: '{"city":"Berlin"}',
          call_id: 'call_1',
          id: 'fc_1',
          name: 'weather_lookup',
          status: 'completed',
          type: 'function_call',
        },
        {
          arguments: '{"city":"Tokyo"}',
          call_id: 'call_2',
          id: 'fc_2',
          name: 'weather_lookup',
          status: 'completed',
          type: 'function_call',
        },
      ],
      status: 'completed',
      usage: {
        input_tokens: 40,
        output_tokens: 15,
      },
    });

    expect(response.finishReason).toBe('tool_call');
    expect(response.text).toBe('Looking up both.');
    expect(response.toolCalls).toEqual([
      { args: { city: 'Berlin' }, id: 'call_1', name: 'weather_lookup' },
      { args: { city: 'Tokyo' }, id: 'call_2', name: 'weather_lookup' },
    ]);
  });

  it('never sends previous_response_id or conversation in the request', () => {
    const request = translateOpenAIRequest({
      messages: [
        { content: 'First', role: 'user' },
        { content: 'Reply', role: 'assistant' },
        { content: 'Follow-up', role: 'user' },
      ],
      model: 'gpt-4o',
    });

    expect(request).not.toHaveProperty('previous_response_id');
    expect(request).not.toHaveProperty('conversation');
    expect(request.store).toBe(false);
  });

  it('streams response.failed event as a ProviderError', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(async () =>
        new Response(
          makeSSEStream([
            {
              response: {
                error: { message: 'Model overloaded' },
                id: 'resp_fail_1',
                model: 'gpt-4o',
                object: 'response',
                output: [],
                status: 'failed',
              },
              sequence_number: 1,
              type: 'response.failed',
            },
          ]),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        ),
      ),
    });

    await expect(
      (async () => {
        for await (const chunk of adapter.stream({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'gpt-4o',
        })) {
          void chunk;
        }
      })(),
    ).rejects.toThrow('Model overloaded');
  });

  it('streams error event as a ProviderError', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(async () =>
        new Response(
          makeSSEStream([
            {
              code: 'server_error',
              message: 'Internal server error',
              type: 'error',
            },
          ]),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        ),
      ),
    });

    await expect(
      (async () => {
        for await (const chunk of adapter.stream({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'gpt-4o',
        })) {
          void chunk;
        }
      })(),
    ).rejects.toThrow('Internal server error');
  });

  it('streams text followed by a tool call in the same stream', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(async () =>
        new Response(
          makeSSEStream([
            {
              content_index: 0,
              delta: 'Let me check',
              item_id: 'msg_1',
              output_index: 0,
              sequence_number: 1,
              type: 'response.output_text.delta',
            },
            {
              item: {
                arguments: '{"q":"weather"}',
                call_id: 'call_search',
                id: 'fc_search',
                name: 'web_search',
                status: 'completed',
                type: 'function_call',
              },
              output_index: 1,
              sequence_number: 2,
              type: 'response.output_item.added',
            },
            {
              item: {
                arguments: '{"q":"weather"}',
                call_id: 'call_search',
                id: 'fc_search',
                name: 'web_search',
                status: 'completed',
                type: 'function_call',
              },
              output_index: 1,
              sequence_number: 3,
              type: 'response.output_item.done',
            },
            {
              response: {
                id: 'resp_mixed_1',
                model: 'gpt-4o',
                object: 'response',
                output: [
                  {
                    content: [
                      {
                        annotations: [],
                        text: 'Let me check',
                        type: 'output_text',
                      },
                    ],
                    id: 'msg_1',
                    role: 'assistant',
                    status: 'completed',
                    type: 'message',
                  },
                  {
                    arguments: '{"q":"weather"}',
                    call_id: 'call_search',
                    id: 'fc_search',
                    name: 'web_search',
                    status: 'completed',
                    type: 'function_call',
                  },
                ],
                status: 'completed',
                usage: {
                  input_tokens: 20,
                  output_tokens: 8,
                },
              },
              sequence_number: 4,
              type: 'response.completed',
            },
          ]),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
      tools: [
        {
          description: 'Search the web',
          name: 'web_search',
          parameters: {
            properties: { q: { type: 'string' } },
            required: ['q'],
            type: 'object',
          },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: 'Let me check', type: 'text-delta' },
      { id: 'call_search', name: 'web_search', type: 'tool-call-start' },
      { argsDelta: '{"q":"weather"}', id: 'call_search', type: 'tool-call-delta' },
      {
        id: 'call_search',
        name: 'web_search',
        result: { q: 'weather' },
        type: 'tool-call-result',
      },
      expect.objectContaining({
        finishReason: 'tool_call',
        type: 'done',
      }),
    ]);
  });

  it('streams response.incomplete event with length finish reason', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(async () =>
        new Response(
          makeSSEStream([
            {
              content_index: 0,
              delta: 'Truncated',
              item_id: 'msg_1',
              output_index: 0,
              sequence_number: 1,
              type: 'response.output_text.delta',
            },
            {
              response: {
                id: 'resp_inc_1',
                incomplete_details: { reason: 'max_output_tokens' },
                model: 'gpt-4o',
                object: 'response',
                output: [
                  {
                    content: [
                      {
                        annotations: [],
                        text: 'Truncated',
                        type: 'output_text',
                      },
                    ],
                    id: 'msg_1',
                    role: 'assistant',
                    status: 'completed',
                    type: 'message',
                  },
                ],
                status: 'incomplete',
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                },
              },
              sequence_number: 2,
              type: 'response.incomplete',
            },
          ]),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: 'Truncated', type: 'text-delta' },
      expect.objectContaining({
        finishReason: 'length',
        type: 'done',
      }),
    ]);
  });

  it('omits instructions field when there is no system content', () => {
    const request = translateOpenAIRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
    });

    expect(request).not.toHaveProperty('instructions');
    expect(request.store).toBe(false);
  });

  it('passes temperature through to the request body', () => {
    const request = translateOpenAIRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
      temperature: 0.7,
    });

    expect(request.temperature).toBe(0.7);
  });

  it('does not send messages or max_completion_tokens fields', () => {
    const request = translateOpenAIRequest({
      maxTokens: 100,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
    });

    expect(request).not.toHaveProperty('messages');
    expect(request).not.toHaveProperty('max_completion_tokens');
    expect(request).toHaveProperty('input');
    expect(request).toHaveProperty('max_output_tokens', 100);
  });

  it('streams two concurrent tool calls tracked independently by call_id', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(async () =>
        new Response(
          makeSSEStream([
            {
              item: {
                arguments: '',
                call_id: 'call_a',
                id: 'fc_a',
                name: 'tool_alpha',
                status: 'in_progress',
                type: 'function_call',
              },
              output_index: 0,
              sequence_number: 1,
              type: 'response.output_item.added',
            },
            {
              item: {
                arguments: '',
                call_id: 'call_b',
                id: 'fc_b',
                name: 'tool_beta',
                status: 'in_progress',
                type: 'function_call',
              },
              output_index: 1,
              sequence_number: 2,
              type: 'response.output_item.added',
            },
            {
              delta: '{"x":1}',
              item_id: 'fc_a',
              output_index: 0,
              sequence_number: 3,
              type: 'response.function_call_arguments.delta',
            },
            {
              delta: '{"y":2}',
              item_id: 'fc_b',
              output_index: 1,
              sequence_number: 4,
              type: 'response.function_call_arguments.delta',
            },
            {
              item: {
                arguments: '{"x":1}',
                call_id: 'call_a',
                id: 'fc_a',
                name: 'tool_alpha',
                status: 'completed',
                type: 'function_call',
              },
              output_index: 0,
              sequence_number: 5,
              type: 'response.output_item.done',
            },
            {
              item: {
                arguments: '{"y":2}',
                call_id: 'call_b',
                id: 'fc_b',
                name: 'tool_beta',
                status: 'completed',
                type: 'function_call',
              },
              output_index: 1,
              sequence_number: 6,
              type: 'response.output_item.done',
            },
            {
              response: {
                id: 'resp_parallel',
                model: 'gpt-4o',
                object: 'response',
                output: [
                  {
                    arguments: '{"x":1}',
                    call_id: 'call_a',
                    id: 'fc_a',
                    name: 'tool_alpha',
                    status: 'completed',
                    type: 'function_call',
                  },
                  {
                    arguments: '{"y":2}',
                    call_id: 'call_b',
                    id: 'fc_b',
                    name: 'tool_beta',
                    status: 'completed',
                    type: 'function_call',
                  },
                ],
                status: 'completed',
                usage: { input_tokens: 30, output_tokens: 20 },
              },
              sequence_number: 7,
              type: 'response.completed',
            },
          ]),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o',
      tools: [
        {
          description: 'Alpha',
          name: 'tool_alpha',
          parameters: { type: 'object' },
        },
        {
          description: 'Beta',
          name: 'tool_beta',
          parameters: { type: 'object' },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    const startA = chunks.find(
      (c) => c.type === 'tool-call-start' && (c as { id: string }).id === 'call_a',
    );
    const startB = chunks.find(
      (c) => c.type === 'tool-call-start' && (c as { id: string }).id === 'call_b',
    );
    const deltaA = chunks.find(
      (c) => c.type === 'tool-call-delta' && (c as { id: string }).id === 'call_a',
    );
    const deltaB = chunks.find(
      (c) => c.type === 'tool-call-delta' && (c as { id: string }).id === 'call_b',
    );
    const resultA = chunks.find(
      (c) => c.type === 'tool-call-result' && (c as { id: string }).id === 'call_a',
    );
    const resultB = chunks.find(
      (c) => c.type === 'tool-call-result' && (c as { id: string }).id === 'call_b',
    );

    expect(startA).toMatchObject({ id: 'call_a', name: 'tool_alpha', type: 'tool-call-start' });
    expect(startB).toMatchObject({ id: 'call_b', name: 'tool_beta', type: 'tool-call-start' });
    expect(deltaA).toMatchObject({ argsDelta: '{"x":1}', id: 'call_a' });
    expect(deltaB).toMatchObject({ argsDelta: '{"y":2}', id: 'call_b' });
    expect(resultA).toMatchObject({ id: 'call_a', name: 'tool_alpha', result: { x: 1 } });
    expect(resultB).toMatchObject({ id: 'call_b', name: 'tool_beta', result: { y: 2 } });
  });

  it('handles zero token usage without errors', () => {
    const response = translateOpenAIResponse({
      id: 'resp_zero',
      model: 'gpt-4o',
      object: 'response',
      output: [
        {
          content: [{ annotations: [], text: 'ok', type: 'output_text' }],
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          type: 'message',
        },
      ],
      status: 'completed',
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    expect(response.usage.inputTokens).toBe(0);
    expect(response.usage.outputTokens).toBe(0);
    expect(response.usage.cachedReadTokens).toBe(0);
    expect(response.usage.costUSD).toBe(0);
    expect(response.text).toBe('ok');
  });

  it('rejects unsupported capability combinations before fetch', async () => {
    const modelRegistry = new ModelRegistry();
    modelRegistry.register({
      contextWindow: 32000,
      id: 'mock-openai-no-capabilities',
      inputPrice: 1,
      lastUpdated: '2026-04-15',
      outputPrice: 2,
      provider: 'openai',
      supportsStreaming: false,
      supportsTools: false,
      supportsVision: false,
    });
    const adapter = new OpenAIAdapter({
      apiKey: 'openai-key',
      fetchImplementation: vi.fn(),
      modelRegistry,
    });

    await expect(
      adapter.complete({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'mock-openai-no-capabilities',
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
        messages: [
          {
            content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
            role: 'user',
          },
        ],
        model: 'mock-openai-no-capabilities',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.stream({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'mock-openai-no-capabilities',
      }).next(),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });
});

function makeSSEStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
