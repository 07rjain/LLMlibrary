import { describe, expect, it, vi } from 'vitest';

import { LLMClient } from '../src/client.js';
import {
  SlidingWindowStrategy,
  SummarisationStrategy,
} from '../src/context-manager.js';
import { Conversation } from '../src/conversation.js';
import {
  BudgetExceededError,
  InvalidConversationSnapshotError,
  MaxToolRoundsError,
  ProviderCapabilityError,
  ProviderError,
} from '../src/errors.js';
import { ModelRouter } from '../src/router.js';
import { InMemorySessionStore } from '../src/session-store.js';

import type {
  ConversationClient,
  ConversationSnapshot,
} from '../src/conversation.js';
import type {
  CanonicalMessage,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolSchema,
  JsonObject,
  JsonValue,
  ResponseFormat,
  StreamChunk,
  ToolExecutionContext,
} from '../src/types.js';

describe('Conversation', () => {
  it('routes tool calls through an external dispatcher', async () => {
    const dispatcher = vi.fn(async () => ({ answer: 42 }));
    const responses: CanonicalResponse[] = [
      {
        content: [],
        finishReason: 'tool_call',
        model: 'mock-model',
        provider: 'mock',
        raw: {},
        text: '',
        toolCalls: [{ args: { value: 7 }, id: 'call-1', name: 'answer' }],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      },
      {
        content: [{ text: 'done', type: 'text' }],
        finishReason: 'stop',
        model: 'mock-model',
        provider: 'mock',
        raw: {},
        text: 'done',
        toolCalls: [],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      },
    ];
    const client: ConversationClient = {
      complete: vi.fn(async () => responses.shift() as CanonicalResponse),
      stream: vi.fn(),
    };
    const conversation = new Conversation(client, {
      sessionId: 'dispatcher-session',
      toolCallDispatcherMetadata: { source: 'dispatcher-test' },
      toolCallDispatcher: { execute: dispatcher },
      tools: [
        {
          description: 'Answer',
          name: 'answer',
          parameters: {
            properties: { value: { type: 'number' } },
            type: 'object',
          },
        },
      ],
    });

    await conversation.send('Call answer.');

    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        call: { args: { value: 7 }, id: 'call-1', name: 'answer' },
        model: 'mock-model',
        provider: 'mock',
        sessionId: 'dispatcher-session',
        metadata: { source: 'dispatcher-test' },
      }),
    );
  });

  it('does not dispatch unregistered tool calls in strict validation mode', async () => {
    const dispatcher = vi.fn(async () => ({ answer: 42 }));
    const responses: CanonicalResponse[] = [
      {
        content: [],
        finishReason: 'tool_call',
        model: 'mock-model',
        provider: 'mock',
        raw: {},
        text: '',
        toolCalls: [{ args: { value: 7 }, id: 'call-1', name: 'unregistered' }],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      },
      {
        content: [{ text: 'done', type: 'text' }],
        finishReason: 'stop',
        model: 'mock-model',
        provider: 'mock',
        raw: {},
        text: 'done',
        toolCalls: [],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      },
    ];
    const conversation = new Conversation(
      {
        complete: vi.fn(async () => responses.shift() as CanonicalResponse),
        stream: vi.fn(),
      },
      {
        sessionId: 'strict-dispatcher-session',
        toolCallDispatcher: { execute: dispatcher },
        toolValidation: 'strict',
      },
    );

    await conversation.send('Call the unregistered tool.');

    expect(dispatcher).not.toHaveBeenCalled();
    expect(JSON.stringify(conversation.history)).toContain(
      'No tool schema registered for \\"unregistered\\".',
    );
  });
  it('generates a session id when one is not supplied', () => {
    const conversation = new Conversation(
      {
        complete: vi.fn(),
        stream: vi.fn(),
      },
      {},
    );

    expect(conversation.id).toBeTruthy();
    expect(typeof conversation.id).toBe('string');
  });

  it('handles minimal request and response paths without optional config', async () => {
    const client: ConversationClient = {
      complete: vi.fn(
        async (): Promise<CanonicalResponse> => ({
          content: [],
          finishReason: 'stop',
          model: 'mock-model',
          provider: 'mock',
          raw: {},
          text: '',
          toolCalls: [],
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 1,
            outputTokens: 0,
          },
        }),
      ),
      stream: vi.fn(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield {
          finishReason: 'stop',
          type: 'done',
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 1,
            outputTokens: 0,
          },
        };
      }),
    };
    const conversation = new Conversation(client);

    await conversation.send('Hi');
    for await (const chunk of conversation.sendStream('Again')) {
      void chunk;
    }

    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ content: 'Hi', role: 'user' }],
        sessionId: conversation.id,
      }),
    );
    expect(client.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { content: 'Hi', role: 'user' },
          { content: '', role: 'assistant' },
          { content: 'Again', role: 'user' },
        ],
        model: 'mock-model',
        provider: 'mock',
        sessionId: conversation.id,
      }),
    );
    expect(conversation.toMessages()).toEqual([
      { content: 'Hi', role: 'user' },
      { content: '', role: 'assistant' },
      { content: 'Again', role: 'user' },
      { content: '', role: 'assistant' },
    ]);
    expect(conversation.serialise()).toMatchObject({
      messages: conversation.history,
      sessionId: conversation.id,
      totalCachedTokens: 0,
      totalCostUSD: 0,
      totalInputTokens: 2,
      totalOutputTokens: 0,
    });
  });

  it('propagates responseFormat through requests and snapshots', async () => {
    const client: ConversationClient = {
      complete: vi.fn(
        async (): Promise<CanonicalResponse> => ({
          content: [{ text: '{"answer":"ok"}', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          parsed: { answer: 'ok' },
          provider: 'openai',
          raw: {},
          responseFormat: 'json_schema',
          structuredOutputStatus: 'parsed',
          text: '{"answer":"ok"}',
          toolCalls: [],
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 1,
            outputTokens: 1,
          },
        }),
      ),
      stream: vi.fn(),
    };
    const responseFormat: ResponseFormat = {
      schema: {
        properties: {
          answer: { type: 'string' },
        },
        type: 'object',
      },
      type: 'json_schema' as const,
    };
    const conversation = new Conversation(client, {
      responseFormat,
      sessionId: 'structured-session',
    });

    await conversation.send('Return a structured response.');

    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat,
      }),
    );
    expect(conversation.serialise()).toMatchObject({
      responseFormat,
      sessionId: 'structured-session',
    });

    const restored = Conversation.restore(client, conversation.serialise());
    expect(restored.serialise()).toMatchObject({
      responseFormat,
      sessionId: 'structured-session',
    });
  });

  it('sends messages, updates totals, and auto-saves snapshots', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>({
      now: () => new Date('2026-04-15T10:00:00.000Z'),
    });
    const client: ConversationClient = {
      complete: vi.fn(
        async (): Promise<CanonicalResponse> => ({
          content: [{ text: 'Hello there', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Hello there',
          toolCalls: [],
          usage: {
            cachedTokens: 2,
            cost: '$0.01',
            costUSD: 0.01,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 3,
          },
        }),
      ),
      stream: vi.fn(),
    };
    const conversation = new Conversation(client, {
      model: 'gpt-4o',
      sessionId: 'session-1',
      store,
      system: 'Be helpful.',
    });

    const response = await conversation.send('Hello');
    const stored = await store.get('session-1');

    expect(response.text).toBe('Hello there');
    expect(conversation.history).toEqual([
      { content: 'Hello', role: 'user' },
      { content: 'Hello there', role: 'assistant' },
    ]);
    expect(conversation.toMessages()).toEqual([
      { content: 'Be helpful.', pinned: true, role: 'system' },
      { content: 'Hello', role: 'user' },
      { content: 'Hello there', role: 'assistant' },
    ]);
    expect(conversation.totals).toEqual({
      cachedTokens: 2,
      cost: '$0.01',
      costUSD: 0.01,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 3,
    });
    expect(stored?.snapshot.messages).toEqual(conversation.history);
    expect(stored?.meta.totalCostUSD).toBe(0.01);
    expect(stored?.snapshot.totalReasoningTokens).toBe(3);
  });

  it('streams responses and commits state on done', async () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield { delta: 'Hello ', type: 'text-delta' };
        yield { delta: 'world', type: 'text-delta' };
        yield {
          finishReason: 'stop',
          type: 'done',
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0.002,
            inputTokens: 12,
            outputTokens: 4,
          },
        };
      }),
    };
    const conversation = new Conversation(client, {
      model: 'gpt-4o',
      sessionId: 'session-stream',
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of conversation.sendStream('Hi')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        delta: 'Hello ',
        type: 'text-delta',
        version: 3,
      }),
      expect.objectContaining({
        delta: 'world',
        type: 'text-delta',
        version: 3,
      }),
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
        version: 3,
      }),
    ]);
    expect(conversation.history).toEqual([
      { content: 'Hi', role: 'user' },
      { content: 'Hello world', role: 'assistant' },
    ]);
    expect(conversation.totals.costUSD).toBe(0.002);
  });

  it('streams tool calls into assistant message parts', async () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield { id: 'tool_1', name: 'lookup', type: 'tool-call-start' };
        yield {
          args: { city: 'Berlin' },
          id: 'tool_1',
          name: 'lookup',
          type: 'tool-call-arguments',
        };
        yield {
          finishReason: 'tool_call',
          type: 'done',
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0.001,
            inputTokens: 6,
            outputTokens: 2,
          },
        };
      }),
    };
    const conversation = new Conversation(client, {
      model: 'gpt-4o',
      sessionId: 'session-tool-stream',
    });

    for await (const chunk of conversation.sendStream('Run a tool')) {
      void chunk;
    }

    expect(conversation.history).toEqual([
      { content: 'Run a tool', role: 'user' },
      {
        content: [
          {
            args: { city: 'Berlin' },
            id: 'tool_1',
            name: 'lookup',
            type: 'tool_call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            isError: true,
            name: 'lookup',
            result: {
              error: {
                message: 'No executable tool registered for "lookup".',
                name: 'Error',
              },
            },
            toolCallId: 'tool_1',
            type: 'tool_result',
          },
        ],
        role: 'user',
      },
    ]);
  });

  it('auto-executes tool calls and returns the final assistant response', async () => {
    const execute = vi.fn(async (args: JsonObject) => ({
      forecast: `${String(args.city)}: sunny`,
    }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: { city: 'Berlin' },
            id: 'tool_1',
            name: 'lookup_weather',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' },
        ],
        usage: usage(10, 2, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Sunny in Berlin.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Sunny in Berlin.',
        toolCalls: [],
        usage: usage(7, 3, 0.02),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'tool-loop-session',
        tools: [buildTool('lookup_weather', execute)],
      },
    );

    const response = await conversation.send('What is the weather in Berlin?');

    expect(execute).toHaveBeenCalledWith(
      { city: 'Berlin' },
      expect.objectContaining({
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'tool-loop-session',
      }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [
          { content: 'What is the weather in Berlin?', role: 'user' },
          {
            content: [
              {
                args: { city: 'Berlin' },
                id: 'tool_1',
                name: 'lookup_weather',
                type: 'tool_call',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                isError: false,
                name: 'lookup_weather',
                result: { forecast: 'Berlin: sunny' },
                toolCallId: 'tool_1',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ],
      }),
    );
    expect(response.text).toBe('Sunny in Berlin.');
    expect(response.usage).toEqual({
      cachedTokens: 0,
      cost: '$0.03',
      costUSD: 0.03,
      inputTokens: 17,
      outputTokens: 5,
    });
    expect(conversation.history).toEqual([
      { content: 'What is the weather in Berlin?', role: 'user' },
      {
        content: [
          {
            args: { city: 'Berlin' },
            id: 'tool_1',
            name: 'lookup_weather',
            type: 'tool_call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            isError: false,
            name: 'lookup_weather',
            result: { forecast: 'Berlin: sunny' },
            toolCallId: 'tool_1',
            type: 'tool_result',
          },
        ],
        role: 'user',
      },
      { content: 'Sunny in Berlin.', role: 'assistant' },
    ]);
    expect(conversation.totals.costUSD).toBe(0.03);
  });

  it('relaxes forced tool choice to auto after the first tool round', async () => {
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: { city: 'Berlin' },
            id: 'tool_1',
            name: 'lookup_weather',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' },
        ],
        usage: usage(10, 2, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Done.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Done.',
        toolCalls: [],
        usage: usage(5, 2, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        model: 'gpt-4o',
        toolChoice: { name: 'lookup_weather', type: 'tool' },
        tools: [
          buildTool(
            'lookup_weather',
            vi.fn(async () => ({ ok: true })),
          ),
        ],
      },
    );

    await conversation.send('Use the tool.');

    expect(complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        toolChoice: { name: 'lookup_weather', type: 'tool' },
      }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toolChoice: { type: 'auto' },
      }),
    );
  });

  it('runs multiple tool calls in parallel', async () => {
    let activeExecutions = 0;
    let maxActiveExecutions = 0;
    const createParallelTool = (name: string) =>
      buildTool(
        name,
        vi.fn(async () => {
          activeExecutions += 1;
          maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeExecutions -= 1;
          return { ok: true };
        }),
      );
    const conversation = new Conversation(
      {
        complete: vi
          .fn<ConversationClient['complete']>()
          .mockResolvedValueOnce({
            content: [
              {
                args: {},
                id: 'tool_1',
                name: 'tool_a',
                type: 'tool_call',
              },
              {
                args: {},
                id: 'tool_2',
                name: 'tool_b',
                type: 'tool_call',
              },
            ],
            finishReason: 'tool_call',
            model: 'gpt-4o',
            provider: 'openai',
            raw: {},
            text: '',
            toolCalls: [
              { args: {}, id: 'tool_1', name: 'tool_a' },
              { args: {}, id: 'tool_2', name: 'tool_b' },
            ],
            usage: usage(4, 1, 0.01),
          })
          .mockResolvedValueOnce({
            content: [{ text: 'Done', type: 'text' }],
            finishReason: 'stop',
            model: 'gpt-4o',
            provider: 'openai',
            raw: {},
            text: 'Done',
            toolCalls: [],
            usage: usage(2, 1, 0.01),
          }),
        stream: vi.fn(),
      },
      {
        model: 'gpt-4o',
        tools: [createParallelTool('tool_a'), createParallelTool('tool_b')],
      },
    );

    await conversation.send('Run both tools.');

    expect(maxActiveExecutions).toBe(2);
  });

  it('returns structured tool errors back to the model when execution fails', async () => {
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: { city: 'Berlin' },
            id: 'tool_1',
            name: 'lookup_weather',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Handled tool failure.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Handled tool failure.',
        toolCalls: [],
        usage: usage(3, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        model: 'gpt-4o',
        tools: [
          buildTool(
            'lookup_weather',
            vi.fn(async () => {
              throw new Error('lookup failed');
            }),
          ),
        ],
      },
    );

    const response = await conversation.send('Use the tool.');

    expect(response.text).toBe('Handled tool failure.');
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            content: [
              {
                isError: true,
                name: 'lookup_weather',
                result: {
                  error: {
                    message: 'lookup failed',
                    name: 'Error',
                  },
                },
                toolCallId: 'tool_1',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]),
      }),
    );
  });

  it('resumes streaming after tool execution and emits a single final done chunk', async () => {
    const execute = vi.fn(async () => ({ forecast: 'Sunny' }));
    const stream = vi
      .fn<ConversationClient['stream']>()
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield { delta: 'Checking ', type: 'text-delta' };
        yield { id: 'tool_1', name: 'lookup_weather', type: 'tool-call-start' };
        yield {
          args: { city: 'Berlin' },
          id: 'tool_1',
          name: 'lookup_weather',
          type: 'tool-call-arguments',
        };
        yield {
          finishReason: 'tool_call',
          type: 'done',
          usage: usage(6, 2, 0.01),
        };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield { delta: 'Sunny in Berlin.', type: 'text-delta' };
        yield {
          finishReason: 'stop',
          type: 'done',
          usage: usage(5, 3, 0.02),
        };
      });
    const conversation = new Conversation(
      {
        complete: vi.fn(),
        stream,
      },
      {
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'stream-tool-loop',
        tools: [buildTool('lookup_weather', execute)],
      },
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of conversation.sendStream('What is the weather?')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      expect.objectContaining({
        delta: 'Checking ',
        type: 'text-delta',
        version: 3,
      }),
      expect.objectContaining({
        id: 'tool_1',
        name: 'lookup_weather',
        type: 'tool-call-start',
        version: 3,
      }),
      expect.objectContaining({
        args: { city: 'Berlin' },
        id: 'tool_1',
        name: 'lookup_weather',
        type: 'tool-call-arguments',
        version: 3,
      }),
      expect.objectContaining({
        id: 'tool_1',
        isError: false,
        name: 'lookup_weather',
        result: { forecast: 'Sunny' },
        type: 'tool-call-result',
        version: 3,
      }),
      expect.objectContaining({
        delta: 'Sunny in Berlin.',
        type: 'text-delta',
        version: 3,
      }),
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
        usage: {
          cachedTokens: 0,
          cost: '$0.03',
          costUSD: 0.03,
          inputTokens: 11,
          outputTokens: 5,
        },
        version: 3,
      }),
    ]);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(conversation.history).toEqual([
      { content: 'What is the weather?', role: 'user' },
      {
        content: [
          { text: 'Checking ', type: 'text' },
          {
            args: { city: 'Berlin' },
            id: 'tool_1',
            name: 'lookup_weather',
            type: 'tool_call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            isError: false,
            name: 'lookup_weather',
            result: { forecast: 'Sunny' },
            toolCallId: 'tool_1',
            type: 'tool_result',
          },
        ],
        role: 'user',
      },
      { content: 'Sunny in Berlin.', role: 'assistant' },
    ]);
  });

  it('validates model-provided tool arguments before execution by default', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: { allowed: 'ok', count: 'not-number', extra: 'unexpected' },
            id: 'tool_1',
            name: 'validated_tool',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          {
            args: { allowed: 'ok', count: 'not-number', extra: 'unexpected' },
            id: 'tool_1',
            name: 'validated_tool',
          },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Handled validation error.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Handled validation error.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        tools: [
          {
            description: 'Validated tool',
            execute,
            name: 'validated_tool',
            parameters: {
              properties: {
                allowed: { type: 'string' },
                count: { type: 'number' },
              },
              required: ['allowed'],
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Run tool');

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: [
              expect.objectContaining({
                isError: true,
                name: 'validated_tool',
                result: {
                  error: expect.objectContaining({
                    message: expect.stringContaining(
                      'arguments.count must be a number',
                    ),
                  }),
                },
                toolCallId: 'tool_1',
                type: 'tool_result',
              }),
            ],
            role: 'user',
          }),
        ]),
      }),
    );
  });

  it('allows invalid tool arguments only in explicit permissive mode', async () => {
    const execute = vi.fn(async (args: JsonObject) => ({
      observed: String(args.count),
    }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: { allowed: 'ok', count: 'not-number', extra: 'unexpected' },
            id: 'tool_1',
            name: 'validated_tool',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          {
            args: { allowed: 'ok', count: 'not-number', extra: 'unexpected' },
            id: 'tool_1',
            name: 'validated_tool',
          },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Permissive done.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Permissive done.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        toolValidation: 'permissive',
        tools: [
          {
            description: 'Validated tool',
            execute,
            name: 'validated_tool',
            parameters: {
              properties: {
                allowed: { type: 'string' },
                count: { type: 'number' },
              },
              required: ['allowed'],
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Run tool');

    expect(execute).toHaveBeenCalledWith(
      { allowed: 'ok', count: 'not-number', extra: 'unexpected' },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('supports strict validation for arrays, booleans, integers, enums, and explicit additional properties', async () => {
    const execute = vi.fn(async (args: JsonObject) => ({ ok: args }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: { flag: true }, id: 'tool_bool', name: 'bool_tool' },
          { args: { count: 2 }, id: 'tool_int', name: 'int_tool' },
          { args: { items: ['a', 'b'] }, id: 'tool_array', name: 'array_tool' },
          { args: { mode: 'fast' }, id: 'tool_enum', name: 'enum_tool' },
          {
            args: { extra: true, known: 'ok' },
            id: 'tool_additional',
            name: 'additional_tool',
          },
          { args: {}, id: 'tool_missing', name: 'missing_tool' },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Validated.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Validated.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        tools: [
          {
            description: 'Boolean tool',
            execute,
            name: 'bool_tool',
            parameters: {
              properties: { flag: { type: 'boolean' } },
              required: ['flag'],
              type: 'object',
            },
          },
          {
            description: 'Integer tool',
            execute,
            name: 'int_tool',
            parameters: {
              properties: { count: { type: 'integer' } },
              required: ['count'],
              type: 'object',
            },
          },
          {
            description: 'Array tool',
            execute,
            name: 'array_tool',
            parameters: {
              properties: {
                items: { items: { type: 'string' }, type: 'array' },
              },
              required: ['items'],
              type: 'object',
            },
          },
          {
            description: 'Enum tool',
            execute,
            name: 'enum_tool',
            parameters: {
              properties: {
                mode: { enum: ['fast'], type: 'string' },
              },
              required: ['mode'],
              type: 'object',
            },
          },
          {
            description: 'Additional properties tool',
            execute,
            name: 'additional_tool',
            parameters: {
              additionalProperties: true,
              properties: {
                known: { type: 'string' },
              },
              required: ['known'],
              type: 'object',
            },
          },
          {
            description: 'Missing required tool',
            execute,
            name: 'missing_tool',
            parameters: {
              properties: {
                value: { type: 'string' },
              },
              required: ['value'],
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Validate tools');

    expect(execute).toHaveBeenCalledTimes(5);
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                isError: true,
                name: 'missing_tool',
                result: {
                  error: expect.objectContaining({
                    message: 'arguments.value is required.',
                  }),
                },
                toolCallId: 'tool_missing',
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('rejects unknown and malformed nested tool arguments in strict mode', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: { extra: 'blocked' }, id: 'tool_extra', name: 'extra_tool' },
          {
            args: { nested: 'not-object' },
            id: 'tool_nested',
            name: 'nested_tool',
          },
          { args: { mode: 'slow' }, id: 'tool_enum', name: 'enum_tool' },
          { args: { items: [1] }, id: 'tool_array', name: 'array_tool' },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Rejected.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Rejected.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        tools: [
          {
            description: 'Extra tool',
            execute,
            name: 'extra_tool',
            parameters: {
              properties: {},
              type: 'object',
            },
          },
          {
            description: 'Nested tool',
            execute,
            name: 'nested_tool',
            parameters: {
              properties: {
                nested: {
                  properties: {
                    value: { type: 'string' },
                  },
                  type: 'object',
                },
              },
              type: 'object',
            },
          },
          {
            description: 'Enum tool',
            execute,
            name: 'enum_tool',
            parameters: {
              properties: {
                mode: { enum: ['fast'], type: 'string' },
              },
              type: 'object',
            },
          },
          {
            description: 'Array tool',
            execute,
            name: 'array_tool',
            parameters: {
              properties: {
                items: { items: { type: 'string' }, type: 'array' },
              },
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Reject bad tools');

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                result: {
                  error: expect.objectContaining({
                    message: 'arguments.extra is not allowed.',
                  }),
                },
                toolCallId: 'tool_extra',
              }),
              expect.objectContaining({
                result: {
                  error: expect.objectContaining({
                    message: 'arguments.nested must be an object.',
                  }),
                },
                toolCallId: 'tool_nested',
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('rejects prototype-sensitive tool argument keys in strict mode', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          {
            args: JSON.parse(
              '{"__proto__":{"polluted":true},"city":"Berlin"}',
            ) as JsonObject,
            id: 'tool_proto',
            name: 'lookup_weather',
          },
          {
            args: { city: 'Berlin', constructor: {} },
            id: 'tool_constructor',
            name: 'lookup_weather',
          },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Rejected.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Rejected.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        tools: [
          {
            description: 'Lookup weather',
            execute,
            name: 'lookup_weather',
            parameters: {
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Reject prototype keys');

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                result: {
                  error: expect.objectContaining({
                    message: 'arguments.__proto__ is not allowed.',
                  }),
                },
                toolCallId: 'tool_proto',
              }),
              expect.objectContaining({
                result: {
                  error: expect.objectContaining({
                    message: 'arguments.constructor is not allowed.',
                  }),
                },
                toolCallId: 'tool_constructor',
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('requires own tool argument properties in strict mode', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const inheritedArgs = Object.create({ city: 'Berlin' }) as JsonObject;
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: inheritedArgs, id: 'tool_inherited', name: 'lookup_weather' },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Rejected.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Rejected.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        tools: [
          {
            description: 'Lookup weather',
            execute,
            name: 'lookup_weather',
            parameters: {
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Reject inherited args');

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                result: {
                  error: expect.objectContaining({
                    message: 'arguments.city is required.',
                  }),
                },
                toolCallId: 'tool_inherited',
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('rejects malformed tool schemas instead of accepting unsupported schema types', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: { value: 'x' }, id: 'tool_schema', name: 'schema_tool' },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Rejected.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Rejected.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        tools: [
          {
            description: 'Malformed schema tool',
            execute,
            name: 'schema_tool',
            parameters: {
              properties: {
                value: {} as CanonicalToolSchema,
              },
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Reject malformed schema');

    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                result: {
                  error: expect.objectContaining({
                    message: 'arguments.value has an unsupported schema type.',
                  }),
                },
                toolCallId: 'tool_schema',
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('passes the remaining session budget into each provider round', async () => {
    const execute = vi.fn(async () => ({ forecast: 'Berlin: sunny' }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: { city: 'Berlin' },
            id: 'tool_1',
            name: 'lookup_weather',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [
          { args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' },
        ],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Done.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Done.',
        toolCalls: [],
        usage: usage(2, 1, 0.02),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        budgetUsd: 0.05,
        model: 'gpt-4o',
        tools: [buildTool('lookup_weather', execute)],
      },
    );

    await conversation.send('Check the weather');

    expect(complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        budgetUsd: 0.05,
      }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        budgetUsd: 0.04,
      }),
    );
  });

  it('throws when the conversation budget is already exhausted', async () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };
    const conversation = new Conversation(client, {
      budgetUsd: 0,
      model: 'gpt-4o',
    });

    await expect(conversation.send('Hi')).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('can warn and continue when the conversation budget is exhausted', async () => {
    const onWarning = vi.fn();
    const client: ConversationClient = {
      complete: vi.fn(
        async (): Promise<CanonicalResponse> => ({
          content: [{ text: 'Still allowed.', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Still allowed.',
          toolCalls: [],
          usage: usage(4, 1, 0.01),
        }),
      ),
      stream: vi.fn(),
    };
    const conversation = new Conversation(client, {
      budgetExceededAction: 'warn',
      budgetUsd: 0,
      model: 'gpt-4o',
      onWarning,
    });

    await expect(conversation.send('Hi')).resolves.toMatchObject({
      text: 'Still allowed.',
    });
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Conversation budget'),
    );
    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetExceededAction: 'warn',
      }),
    );
  });

  it('can skip provider execution when the conversation budget is exhausted', async () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };
    const conversation = new Conversation(client, {
      budgetExceededAction: 'skip',
      budgetUsd: 0,
      model: 'gpt-4o',
      provider: 'openai',
    });

    const response = await conversation.send('Hi');

    expect(response.finishReason).toBe('error');
    expect(response.text).toContain('Conversation budget');
    expect(client.complete).not.toHaveBeenCalled();
    expect(conversation.history.at(-1)).toEqual({
      content: 'Conversation budget of $0.00 has been exhausted.',
      role: 'assistant',
    });
  });

  it('throws MaxToolRoundsError when the model keeps requesting tools', async () => {
    const conversation = new Conversation(
      {
        complete: vi.fn<ConversationClient['complete']>().mockResolvedValue({
          content: [
            {
              args: {},
              id: 'tool_1',
              name: 'lookup_weather',
              type: 'tool_call',
            },
          ],
          finishReason: 'tool_call',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: '',
          toolCalls: [{ args: {}, id: 'tool_1', name: 'lookup_weather' }],
          usage: usage(4, 1, 0.01),
        }),
        stream: vi.fn(),
      },
      {
        maxToolRounds: 1,
        model: 'gpt-4o',
        tools: [
          buildTool(
            'lookup_weather',
            vi.fn(async () => ({ ok: true })),
          ),
        ],
      },
    );

    await expect(conversation.send('Loop forever.')).rejects.toBeInstanceOf(
      MaxToolRoundsError,
    );
  });

  it('throws if a stream ends without a done chunk', async () => {
    const conversation = new Conversation(
      {
        complete: vi.fn(),
        stream: vi.fn(async function* (): AsyncGenerator<
          StreamChunk,
          void,
          void
        > {
          yield { delta: 'Partial', type: 'text-delta' };
        }),
      },
      { model: 'gpt-4o', sessionId: 'session-no-done' },
    );

    await expect(async () => {
      for await (const chunk of conversation.sendStream('Hi')) {
        void chunk;
      }
    }).rejects.toThrow('Streaming conversation ended without a done chunk.');
  });

  it('serialises, restores, and clears while preserving system and totals', async () => {
    const client: ConversationClient = {
      complete: vi.fn(
        async (): Promise<CanonicalResponse> => ({
          content: [{ text: 'Reply', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Reply',
          toolCalls: [],
          usage: {
            cachedTokens: 0,
            cost: '$0.01',
            costUSD: 0.01,
            inputTokens: 8,
            outputTokens: 3,
          },
        }),
      ),
      stream: vi.fn(),
    };
    const original = new Conversation(client, {
      model: 'gpt-4o',
      sessionId: 'session-restore',
      system: 'System prompt',
    });
    await original.send('Hello');

    const snapshot = original.serialise();
    const restored = Conversation.restore(client, snapshot);
    restored.clear();

    expect(restored.history).toEqual([]);
    expect(restored.toMessages()).toEqual([
      { content: 'System prompt', pinned: true, role: 'system' },
    ]);
    expect(restored.totals.costUSD).toBe(0.01);
  });

  it('serialises full tool-loop config and lets restore override stored tools', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const client: ConversationClient = {
      complete: vi
        .fn<ConversationClient['complete']>()
        .mockResolvedValueOnce({
          content: [
            {
              args: {},
              id: 'tool_1',
              name: 'lookup_weather',
              type: 'tool_call',
            },
          ],
          finishReason: 'tool_call',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: '',
          toolCalls: [{ args: {}, id: 'tool_1', name: 'lookup_weather' }],
          usage: usage(4, 1, 0.01),
        })
        .mockResolvedValueOnce({
          content: [{ text: 'Restored.', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o',
          provider: 'openai',
          raw: {},
          text: 'Restored.',
          toolCalls: [],
          usage: usage(2, 1, 0.01),
        }),
      stream: vi.fn(),
    };
    const original = new Conversation(client, {
      budgetUsd: 2,
      maxContextTokens: 2048,
      maxTokens: 128,
      maxToolRounds: 2,
      model: 'gpt-4o',
      provider: 'openai',
      sessionId: 'full-config-session',
      system: 'System prompt',
      tenantId: 'tenant-1',
      toolChoice: { name: 'lookup_weather', type: 'tool' },
      toolExecutionTimeoutMs: 250,
      tools: [buildTool('lookup_weather', execute)],
    });

    const snapshot = original.serialise();
    expect(snapshot).toMatchObject({
      budgetUsd: 2,
      maxContextTokens: 2048,
      maxTokens: 128,
      maxToolRounds: 2,
      model: 'gpt-4o',
      provider: 'openai',
      sessionId: 'full-config-session',
      system: 'System prompt',
      tenantId: 'tenant-1',
      toolChoice: { name: 'lookup_weather', type: 'tool' },
      toolExecutionTimeoutMs: 250,
    });

    const restored = Conversation.restore(client, snapshot, {
      maxToolRounds: 3,
      toolExecutionTimeoutMs: 500,
      tools: [buildTool('lookup_weather', execute)],
    });
    await restored.send('Use the restored tool.');

    expect(execute).toHaveBeenCalled();
    expect(restored.serialise()).toMatchObject({
      maxToolRounds: 3,
      toolExecutionTimeoutMs: 500,
    });
  });

  it('prefers trusted restore options over stored conversation policy', () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };
    const snapshot: ConversationSnapshot = {
      budgetUsd: 999,
      createdAt: '2026-04-15T10:00:00.000Z',
      maxContextTokens: 999_999,
      maxTokens: 999_999,
      maxToolRounds: 99,
      messages: [{ content: 'Stored user turn', role: 'user' }],
      model: 'stored-model',
      provider: 'openai',
      providerOptions: {
        openai: {
          promptCaching: {
            key: 'stored-cache-key',
            retention: '24h',
          },
        },
      },
      responseFormat: { type: 'json_object' },
      sessionId: 'stored-policy-session',
      system: 'Stored system',
      tenantId: 'stored-tenant',
      toolChoice: { type: 'none' },
      toolExecutionTimeoutMs: 250_000,
      toolValidation: 'permissive',
      totalCachedTokens: 0,
      totalCostUSD: 1,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      updatedAt: '2026-04-15T10:00:00.000Z',
    };

    const restored = Conversation.restore(client, snapshot, {
      budgetUsd: 1,
      maxContextTokens: 2048,
      maxTokens: 256,
      maxToolRounds: 2,
      model: 'trusted-model',
      provider: 'google',
      providerOptions: {
        google: {
          thinking: {
            level: 'minimal',
          },
        },
      },
      responseFormat: {
        name: 'trusted_response',
        schema: {
          properties: {
            answer: { type: 'string' },
          },
          type: 'object',
        },
        type: 'json_schema',
      },
      system: 'Trusted system',
      tenantId: 'trusted-tenant',
      toolChoice: { type: 'auto' },
      toolExecutionTimeoutMs: 1_000,
      toolValidation: 'strict',
    });

    expect(restored.serialise()).toMatchObject({
      budgetUsd: 1,
      maxContextTokens: 2048,
      maxTokens: 256,
      maxToolRounds: 2,
      model: 'trusted-model',
      provider: 'google',
      sessionId: 'stored-policy-session',
      system: 'Trusted system',
      tenantId: 'trusted-tenant',
      toolChoice: { type: 'auto' },
      toolExecutionTimeoutMs: 1_000,
      totalCostUSD: 1,
    });
    expect(restored.serialise().toolValidation).toBeUndefined();
    expect(restored.history).toEqual([
      { content: 'Stored user turn', role: 'user' },
    ]);
  });

  it('rejects non-finite or excessive tool loop limits', () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };
    const snapshot: ConversationSnapshot = {
      createdAt: '2026-04-15T10:00:00.000Z',
      messages: [],
      sessionId: 'stored-limit-session',
      totalCachedTokens: 0,
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      updatedAt: '2026-04-15T10:00:00.000Z',
    };

    expect(
      () =>
        new Conversation(client, { maxToolRounds: Number.POSITIVE_INFINITY }),
    ).toThrow('maxToolRounds must be an integer between 0 and 100.');
    expect(() => new Conversation(client, { maxToolRounds: 101 })).toThrow(
      'maxToolRounds must be an integer between 0 and 100.',
    );
    expect(
      () =>
        new Conversation(client, {
          toolExecutionTimeoutMs: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(
      'toolExecutionTimeoutMs must be a finite number between 1 and 300000.',
    );
    expect(() =>
      Conversation.restore(client, {
        ...snapshot,
        maxToolRounds: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(InvalidConversationSnapshotError);
    expect(() =>
      Conversation.restore(client, {
        ...snapshot,
        toolExecutionTimeoutMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(InvalidConversationSnapshotError);
  });

  it('rejects unsafe snapshot roots without invoking accessors or effects', () => {
    const complete = vi.fn();
    const stream = vi.fn();
    const store = { set: vi.fn() };
    const getter = vi.fn(() => []);
    const withGetter = Object.defineProperty(
      { ...validSnapshot() },
      'messages',
      { enumerable: true, get: getter },
    );
    const withSymbol = {
      ...validSnapshot(),
      [Symbol('secret')]: 'hidden',
    };
    const classInstance = Object.assign(
      new (class StoredConversation {})(),
      validSnapshot(),
    );
    const inherited = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      validSnapshot(),
    );
    const throwingProxy = new Proxy(validSnapshot(), {
      getPrototypeOf() {
        throw new Error('private proxy failure');
      },
    });

    for (const candidate of [
      null,
      [],
      classInstance,
      inherited,
      withGetter,
      withSymbol,
      throwingProxy,
    ]) {
      let error: unknown;
      try {
        Conversation.restore({ complete, stream }, candidate, {
          onCompaction: vi.fn(),
          onWarning: vi.fn(),
          store: store as never,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(InvalidConversationSnapshotError);
      expect(error).toMatchObject({
        details: {
          code: 'invalid_conversation_snapshot',
          constraint: expect.any(String),
          path: expect.any(String),
        },
        message: 'Conversation snapshot is invalid.',
        retryable: false,
        statusCode: 400,
      });
      expect(
        Object.keys(
          (error as InvalidConversationSnapshotError).details ?? {},
        ).sort(),
      ).toEqual(['code', 'constraint', 'path']);
      expect(
        JSON.stringify((error as Error & { toJSON(): unknown }).toJSON()),
      ).not.toContain('private proxy failure');
    }

    expect(getter).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('validates snapshot identifiers, timestamps, totals, and numeric options', () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };
    const invalidSnapshots: Array<[string, unknown, string]> = [
      ['sessionId', '', 'non_empty_string_without_control_characters'],
      ['sessionId', 'bad\nid', 'non_empty_string_without_control_characters'],
      ['createdAt', 'not-a-date', 'parseable_date'],
      ['updatedAt', 'not-a-date', 'parseable_date'],
      ['updatedAt', '2026-04-15T09:59:59.999Z', 'not_before_created_at'],
    ];
    for (const [field, value, constraint] of invalidSnapshots) {
      expect(() =>
        Conversation.restore(client, {
          ...validSnapshot(),
          [field]: value,
        }),
      ).toThrowError(
        expect.objectContaining({
          details: {
            code: 'invalid_conversation_snapshot',
            constraint,
            path: `snapshot.${field}`,
          },
        }),
      );
    }

    const invalidNumbers = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const field of [
      'totalCachedTokens',
      'totalInputTokens',
      'totalOutputTokens',
      'totalReasoningTokens',
    ] as const) {
      for (const value of invalidNumbers) {
        expect(() =>
          Conversation.restore(client, {
            ...validSnapshot(),
            [field]: value,
          }),
        ).toThrow(InvalidConversationSnapshotError);
      }
    }
    for (const value of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() =>
        Conversation.restore(client, {
          ...validSnapshot(),
          totalCostUSD: value,
        }),
      ).toThrow(InvalidConversationSnapshotError);
    }

    const invalidOptions: Array<[string, unknown]> = [
      ['budgetUsd', Number.NaN],
      ['budgetUsd', -1],
      ['maxContextTokens', 1.5],
      ['maxContextTokens', Number.MAX_SAFE_INTEGER + 1],
      ['maxTokens', Number.POSITIVE_INFINITY],
      ['maxTokens', -1],
      ['maxToolRounds', 1.5],
      ['maxToolRounds', 101],
      ['toolExecutionTimeoutMs', 0],
      ['toolExecutionTimeoutMs', Number.NEGATIVE_INFINITY],
    ];
    for (const [field, value] of invalidOptions) {
      expect(() =>
        Conversation.restore(client, {
          ...validSnapshot(),
          [field]: value,
        }),
      ).toThrow(InvalidConversationSnapshotError);
    }

    for (const providerOptions of [
      { unsupported: {} },
      { openai: [] },
      { openai: { reasoning: { effort: 'ultra' } } },
      { google: { thinking: { budgetTokens: Number.NaN } } },
      { anthropic: { thinking: { budgetTokens: -1, type: 'enabled' } } },
      { anthropic: { thinking: { budgetTokens: 10 } } },
    ]) {
      expect(() =>
        Conversation.restore(client, {
          ...validSnapshot(),
          providerOptions,
        }),
      ).toThrow(InvalidConversationSnapshotError);
    }

    for (const requiredField of [
      'createdAt',
      'messages',
      'sessionId',
      'totalCachedTokens',
      'totalCostUSD',
      'totalInputTokens',
      'totalOutputTokens',
      'updatedAt',
    ]) {
      expect(() =>
        Conversation.restore(client, {
          ...validSnapshot(),
          [requiredField]: undefined,
        }),
      ).toThrow(InvalidConversationSnapshotError);
    }
  });

  it('validates dense canonical snapshot messages and tool payloads', () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };
    const cyclicArgs: Record<string, unknown> = {};
    cyclicArgs.self = cyclicArgs;
    const pollutedArgs = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(pollutedArgs, '__proto__', {
      enumerable: true,
      value: 'blocked',
    });
    const sparseMessages = new Array<CanonicalMessage>(1);
    const invalidMessages: unknown[] = [
      null,
      sparseMessages,
      [{ content: 'bad role', role: 'tool' }],
      [{ content: new Array(1), role: 'user' }],
      [
        {
          content: [{ args: {}, id: '', name: 'lookup', type: 'tool_call' }],
          role: 'assistant',
        },
      ],
      [
        {
          content: [{ args: {}, id: 'call-1', name: '', type: 'tool_call' }],
          role: 'assistant',
        },
      ],
      [
        {
          content: [
            {
              args: cyclicArgs,
              id: 'call-1',
              name: 'lookup',
              type: 'tool_call',
            },
          ],
          role: 'assistant',
        },
      ],
      [
        {
          content: [
            {
              args: pollutedArgs,
              id: 'call-1',
              name: 'lookup',
              type: 'tool_call',
            },
          ],
          role: 'assistant',
        },
      ],
      [
        {
          content: [
            {
              result: Number.NaN,
              toolCallId: 'call-1',
              type: 'tool_result',
            },
          ],
          role: 'user',
        },
      ],
      [
        {
          content: [{ result: null, toolCallId: '', type: 'tool_result' }],
          role: 'user',
        },
      ],
    ];

    for (const messages of invalidMessages) {
      expect(() =>
        Conversation.restore(client, {
          ...validSnapshot(),
          messages,
        }),
      ).toThrow(InvalidConversationSnapshotError);
    }
  });

  it('does not let trusted overrides bypass stored corruption', () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };

    expect(() =>
      Conversation.restore(
        client,
        { ...validSnapshot(), maxTokens: Number.NaN },
        { maxTokens: 64, model: 'trusted-model', provider: 'mock' },
      ),
    ).toThrowError(
      expect.objectContaining({
        details: {
          code: 'invalid_conversation_snapshot',
          constraint: 'finite_non_negative_safe_integer',
          path: 'snapshot.maxTokens',
        },
      }),
    );
  });

  it('restores legacy snapshots, ignores unknown safe fields, and deep clones', () => {
    const snapshot = {
      ...validSnapshot(),
      budgetUsd: undefined,
      futureField: { version: 2 },
      maxContextTokens: undefined,
      maxTokens: undefined,
      messages: [
        {
          content: [
            {
              args: { city: 'Paris' },
              cacheControl: undefined,
              id: 'call-1',
              name: 'lookup',
              type: 'tool_call' as const,
            },
          ],
          metadata: undefined,
          pinned: undefined,
          role: 'assistant' as const,
        },
      ],
      model: undefined,
      provider: undefined,
      providerOptions: {
        anthropic: undefined,
        google: {
          thinking: {
            budgetTokens: undefined,
            includeThoughts: undefined,
            level: undefined,
          },
        },
        openai: undefined,
      },
      responseFormat: undefined,
      system: undefined,
      tenantId: undefined,
      toolChoice: undefined,
      tools: undefined,
      toolValidation: undefined,
      totalReasoningTokens: undefined,
    };
    const restored = Conversation.restore(
      { complete: vi.fn(), stream: vi.fn() },
      snapshot,
    );

    (snapshot.messages[0]!.content[0] as { args: { city: string } }).args.city =
      'mutated';
    expect(restored.history).toEqual([
      {
        content: [
          {
            args: { city: 'Paris' },
            id: 'call-1',
            name: 'lookup',
            type: 'tool_call',
          },
        ],
        role: 'assistant',
      },
    ]);
    expect(restored.totals.reasoningTokens).toBe(0);
    expect(restored.serialise()).not.toHaveProperty('futureField');
  });

  it('enforces snapshot thinking-budget integer boundaries', () => {
    const client: ConversationClient = {
      complete: vi.fn(),
      stream: vi.fn(),
    };
    const restoreWithThinking = (providerOptions: unknown) =>
      Conversation.restore(client, {
        ...validSnapshot(),
        providerOptions,
      });

    expect(() =>
      restoreWithThinking({
        anthropic: { thinking: { budgetTokens: 0, type: 'enabled' } },
      }),
    ).not.toThrow();
    expect(() =>
      restoreWithThinking({
        google: { thinking: { budgetTokens: -1 } },
      }),
    ).not.toThrow();
    expect(() =>
      restoreWithThinking({
        google: { thinking: { budgetTokens: 0 } },
      }),
    ).not.toThrow();

    for (const providerOptions of [
      { anthropic: { thinking: { budgetTokens: -1, type: 'enabled' } } },
      { google: { thinking: { budgetTokens: -2 } } },
      { google: { thinking: { budgetTokens: 1.5 } } },
      {
        google: {
          thinking: { budgetTokens: Number.MAX_SAFE_INTEGER + 1 },
        },
      },
    ]) {
      expect(() => restoreWithThinking(providerOptions)).toThrow(
        InvalidConversationSnapshotError,
      );
    }
  });

  it('exports markdown transcripts with session metadata and structured parts', async () => {
    const conversation = new Conversation(
      {
        complete: vi.fn(
          async (): Promise<CanonicalResponse> => ({
            content: [
              { text: 'Looking this up.', type: 'text' },
              {
                args: { city: 'Berlin' },
                id: 'tool_1',
                name: 'lookup_weather',
                type: 'tool_call',
              },
            ],
            finishReason: 'tool_call',
            model: 'gpt-4o',
            provider: 'openai',
            raw: {},
            text: 'Looking this up.',
            toolCalls: [
              {
                args: { city: 'Berlin' },
                id: 'tool_1',
                name: 'lookup_weather',
              },
            ],
            usage: {
              cachedTokens: 0,
              cost: '$0.01',
              costUSD: 0.01,
              inputTokens: 12,
              outputTokens: 4,
            },
          }),
        ),
        stream: vi.fn(),
      },
      {
        model: 'gpt-4o',
        sessionId: 'session-markdown',
        system: 'Keep responses concise.',
        tenantId: 'tenant-1',
      },
    );

    await conversation.send('What is the weather?');
    const markdown = conversation.toMarkdown();

    expect(markdown).toContain('# Conversation session-markdown');
    expect(markdown).toContain('| Model | gpt-4o |');
    expect(markdown).toContain('| Tenant ID | tenant-1 |');
    expect(markdown).toContain('## System');
    expect(markdown).toContain('Keep responses concise.');
    expect(markdown).toContain('## User');
    expect(markdown).toContain('What is the weather?');
    expect(markdown).toContain('Tool Call: `lookup_weather`');
  });

  it('restores stored conversations through LLMClient.conversation()', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>({
      now: () => new Date('2026-04-15T10:00:00.000Z'),
    });
    await store.set(
      'stored-session',
      {
        createdAt: '2026-04-15T10:00:00.000Z',
        messages: [{ content: 'Hello again', role: 'user' }],
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'stored-session',
        system: 'Stored system',
        totalCachedTokens: 0,
        totalCostUSD: 0.25,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        updatedAt: '2026-04-15T10:00:00.000Z',
      },
      {
        model: 'gpt-4o',
        provider: 'openai',
      },
    );

    const client = new LLMClient({
      sessionStore: store,
    });
    const conversation = await client.conversation({
      sessionId: 'stored-session',
    });

    expect(conversation.toMessages()).toEqual([
      { content: 'Stored system', pinned: true, role: 'system' },
      { content: 'Hello again', role: 'user' },
    ]);
    expect(conversation.totals.costUSD).toBe(0.25);
  });

  it('preserves providerOptions through conversation sends and persistence', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>({
      now: () => new Date('2026-04-15T10:00:00.000Z'),
    });
    const client = LLMClient.mock({
      defaultModel: 'gpt-4o',
      defaultProvider: 'openai',
      responses: [
        async (options) => {
          expect(options.providerOptions).toEqual({
            openai: {
              promptCaching: {
                key: 'support-faq-v1',
                retention: '24h',
              },
            },
          });

          return {
            content: [{ text: 'Stored with caching hints.', type: 'text' }],
            finishReason: 'stop',
            model: 'gpt-4o',
            provider: 'openai',
            raw: {},
            text: 'Stored with caching hints.',
            toolCalls: [],
            usage: {
              cachedTokens: 5,
              cost: '$0.0010',
              costUSD: 0.001,
              inputTokens: 10,
              outputTokens: 5,
            },
          };
        },
      ],
      sessionStore: store,
    });

    const conversation = await client.conversation({
      providerOptions: {
        openai: {
          promptCaching: {
            key: 'support-faq-v1',
            retention: '24h',
          },
        },
      },
      sessionId: 'cache-session',
      system: 'Be concise.',
    });

    await conversation.send('Hello');

    const stored = await store.get('cache-session');
    expect(stored?.snapshot.providerOptions).toEqual({
      openai: {
        promptCaching: {
          key: 'support-faq-v1',
          retention: '24h',
        },
      },
    });
  });

  it('creates a fresh conversation when the session store has no record', async () => {
    const client = new LLMClient({
      sessionStore: new InMemorySessionStore<ConversationSnapshot>(),
    });

    const conversation = await client.conversation({
      model: 'gpt-4o',
      sessionId: 'missing-session',
      system: 'Fresh system',
    });

    expect(conversation.toMessages()).toEqual([
      { content: 'Fresh system', pinned: true, role: 'system' },
    ]);
  });

  it('passes caller correlation and resolved defaults to complete context rounds', async () => {
    const usage = {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: 1,
      outputTokens: 1,
    };
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [],
        finishReason: 'tool_call',
        model: 'resolved-model',
        provider: 'mock',
        raw: {},
        text: '',
        toolCalls: [{ args: { city: 'Berlin' }, id: 'call-1', name: 'lookup' }],
        usage,
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Done.', type: 'text' }],
        finishReason: 'stop',
        model: 'resolved-model',
        provider: 'mock',
        raw: {},
        text: 'Done.',
        toolCalls: [],
        usage,
      });
    const contextRounds: Array<{
      model?: string;
      provider?: string;
      requestId?: string;
      toolRound?: number;
    }> = [];
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      {
        contextManager: {
          shouldTrim: vi.fn((_messages, context) => {
            contextRounds.push(context);
            return false;
          }),
          trim: vi.fn(),
        },
        sessionId: 'implicit-complete-context',
        toolCallDispatcher: {
          execute: vi.fn(async () => ({ temperature: 20 })),
        },
        tools: [
          {
            description: 'Look up a city',
            name: 'lookup',
            parameters: {
              properties: { city: { type: 'string' } },
              type: 'object',
            },
          },
        ],
      },
    );

    await conversation.send('Look up Berlin.', {
      metadata: { source: 'conversation-test' },
      requestId: 'caller-request-123',
    });

    expect(complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metadata: { source: 'conversation-test' },
        requestId: 'caller-request-123',
      }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        metadata: { source: 'conversation-test' },
        requestId: 'caller-request-123',
      }),
    );
    expect(contextRounds).toEqual([
      expect.objectContaining({
        requestId: 'caller-request-123',
        toolRound: 0,
      }),
      expect.objectContaining({
        model: 'resolved-model',
        provider: 'mock',
        requestId: 'caller-request-123',
        toolRound: 1,
      }),
    ]);
  });

  it('resolves implicit initial route metadata before context trimming', async () => {
    const contextRounds: Array<Record<string, unknown>> = [];
    const client = LLMClient.mock({
      modelRouter: new ModelRouter({
        rules: [{ name: 'initial-route', target: 'gpt-4o-mini' }],
      }),
      responses: [
        {
          content: [{ text: 'Done.', type: 'text' }],
          finishReason: 'stop',
          model: 'gpt-4o-mini',
          provider: 'openai',
          raw: {},
          text: 'Done.',
          toolCalls: [],
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 2,
            outputTokens: 1,
          },
        },
      ],
    });
    const conversation = await client.conversation({
      contextManager: {
        shouldTrim: vi.fn((_messages, context) => {
          contextRounds.push(context);
          return false;
        }),
        trim: vi.fn(),
      },
      maxTokens: 64,
      sessionId: 'implicit-initial-route',
    });

    await conversation.send('Hello');

    expect(contextRounds[0]).toEqual(
      expect.objectContaining({
        contextWindow: 128_000,
        model: 'gpt-4o-mini',
        provider: 'openai',
        reservedOutputTokens: 64,
        toolRound: 0,
      }),
    );
  });

  it('isolates custom context-manager mutations before dispatch', async () => {
    const complete = vi.fn<ConversationClient['complete']>(
      async (_options) => ({
        content: [{ text: 'Done.', type: 'text' }],
        finishReason: 'stop',
        model: 'mock-model',
        provider: 'mock',
        raw: {},
        text: 'Done.',
        toolCalls: [],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      }),
    );
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      {
        contextManager: {
          shouldTrim: vi.fn((messages) => {
            messages[0]!.content = 'mutated';
            return false;
          }),
          trim: vi.fn(),
        },
        messages: [{ content: 'original', role: 'user' }],
      },
    );

    await conversation.send('next');

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { content: 'original', role: 'user' },
          { content: 'next', role: 'user' },
        ],
      }),
    );
    expect(conversation.history[0]).toEqual({
      content: 'original',
      role: 'user',
    });
  });

  it('rejects invalid custom context output before callbacks or dispatch', async () => {
    const complete = vi.fn<ConversationClient['complete']>();
    const onCompaction = vi.fn();
    const getter = vi.fn(() => 'bad');
    const invalidMessage = Object.defineProperty({ role: 'user' }, 'content', {
      enumerable: true,
      get: getter,
    });
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      {
        contextManager: {
          shouldTrim: vi.fn(() => true),
          trim: vi.fn(() => [invalidMessage] as unknown as CanonicalMessage[]),
        },
        messages: [{ content: 'original', role: 'user' }],
        onCompaction,
      },
    );

    await expect(conversation.send('next')).rejects.toMatchObject({
      details: expect.objectContaining({
        code: 'invalid_context_manager_output',
      }),
      statusCode: 400,
    });
    expect(getter).not.toHaveBeenCalled();
    expect(onCompaction).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(conversation.history).toEqual([
      { content: 'original', role: 'user' },
    ]);
  });

  it('preserves custom context-manager error identity', async () => {
    const expected = new Error('context failed');
    const conversation = new Conversation(
      { complete: vi.fn(), stream: vi.fn() },
      {
        contextManager: {
          shouldTrim: () => true,
          trim: () => {
            throw expected;
          },
        },
      },
    );

    await expect(conversation.send('next')).rejects.toBe(expected);
  });

  it('rejects invalid budgets and duplicate tools during construction', () => {
    const client = { complete: vi.fn(), stream: vi.fn() };
    expect(
      () =>
        new Conversation(client, {
          budgetUsd: Number.NaN,
        }),
    ).toThrow(ProviderCapabilityError);

    const tool: CanonicalTool = {
      description: 'Lookup',
      name: 'lookup',
      parameters: { type: 'object' },
    };
    expect(
      () =>
        new Conversation(client, {
          tools: [tool, tool],
        }),
    ).toThrow(ProviderCapabilityError);
  });

  it('pins the router-selected initial route for the provider request', async () => {
    const requests: Array<{ model?: string; provider?: string }> = [];
    const client = LLMClient.mock({
      defaultModel: 'gpt-4o',
      defaultProvider: 'openai',
      modelRouter: new ModelRouter({
        rules: [{ name: 'initial-route', target: 'gpt-4o-mini' }],
      }),
      responses: [
        (options) => {
          requests.push(options);
          return {
            content: [{ text: 'Done.', type: 'text' }],
            finishReason: 'stop',
            model: 'gpt-4o-mini',
            provider: 'openai',
            raw: {},
            text: 'Done.',
            toolCalls: [],
            usage: {
              cachedTokens: 0,
              cost: '$0.00',
              costUSD: 0,
              inputTokens: 2,
              outputTokens: 1,
            },
          };
        },
      ],
    });
    const conversation = await client.conversation({
      sessionId: 'router-context-route',
    });

    await conversation.send('Hello');

    expect(requests[0]).toEqual(
      expect.objectContaining({
        model: 'gpt-4o-mini',
        provider: 'openai',
        resolvedRoute: {
          attempts: [
            {
              decision: 'rule:initial-route:primary:gpt-4o-mini',
              model: 'gpt-4o-mini',
              provider: 'openai',
            },
          ],
          model: 'gpt-4o-mini',
          provider: 'openai',
        },
      }),
    );
    expect(conversation.serialise()).toEqual(
      expect.objectContaining({
        model: 'gpt-4o-mini',
        provider: 'openai',
      }),
    );
  });

  it('rejects invalid token estimates before dispatching to a provider', async () => {
    const complete = vi.fn();
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        contextManager: new SlidingWindowStrategy({
          maxTokens: 1,
          tokenEstimator: () => Number.NaN,
        }),
        messages: [{ content: 'Older context', role: 'assistant' }],
        sessionId: 'invalid-estimator',
      },
    );

    await expect(conversation.send('Latest')).rejects.toBeInstanceOf(
      ProviderCapabilityError,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('applies a context manager before requests and preserves structured assistant content', async () => {
    const trim = vi.fn((messages: CanonicalMessage[]) => messages.slice(1));
    const complete = vi.fn(
      async (): Promise<CanonicalResponse> => ({
        content: [
          { text: 'Checking.', type: 'text' },
          {
            args: { city: 'Berlin' },
            id: 'call_1',
            name: 'lookup',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Checking.',
        toolCalls: [{ args: { city: 'Berlin' }, id: 'call_1', name: 'lookup' }],
        usage: {
          cachedTokens: 1,
          cost: '$0.01',
          costUSD: 0.01,
          inputTokens: 10,
          outputTokens: 4,
        },
      }),
    );
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        contextManager: {
          shouldTrim: vi.fn(() => true),
          trim,
        },
        maxContextTokens: 100,
        maxTokens: 42,
        messages: [
          { content: 'Older prompt', role: 'user' },
          { content: 'Older reply', role: 'assistant' },
        ],
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'trimmed-session',
        system: 'System prompt',
        toolChoice: { type: 'auto' },
        tools: [
          {
            description: 'Lookup',
            name: 'lookup',
            parameters: { type: 'object' },
          },
        ],
      },
    );

    const controller = new AbortController();
    await conversation.send([{ text: 'Newest question', type: 'text' }], {
      signal: controller.signal,
    });

    expect(trim).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 42,
        messages: [
          { content: 'Older reply', role: 'assistant' },
          {
            content: [{ text: 'Newest question', type: 'text' }],
            role: 'user',
          },
        ],
        model: 'gpt-4o',
        provider: 'openai',
        signal: controller.signal,
        system: 'System prompt',
        toolChoice: { type: 'auto' },
        tools: [
          {
            description: 'Lookup',
            name: 'lookup',
            parameters: { type: 'object' },
          },
        ],
      }),
    );
    expect(conversation.history.at(-1)).toEqual({
      content: [
        { text: 'Checking.', type: 'text' },
        {
          args: { city: 'Berlin' },
          id: 'call_1',
          name: 'lookup',
          type: 'tool_call',
        },
      ],
      role: 'assistant',
    });
  });

  it('awaits asynchronous context managers before issuing provider calls', async () => {
    const complete = vi.fn(
      async (): Promise<CanonicalResponse> => ({
        content: [{ text: 'Trimmed.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Trimmed.',
        toolCalls: [],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 4,
          outputTokens: 1,
        },
      }),
    );
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        contextManager: {
          shouldTrim: vi.fn(async () => true),
          trim: vi.fn(async (messages: CanonicalMessage[]) =>
            messages.slice(1),
          ),
        },
        messages: [
          { content: 'Oldest', role: 'user' },
          { content: 'Newest context', role: 'assistant' },
        ],
      },
    );

    await conversation.send('Latest');

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { content: 'Newest context', role: 'assistant' },
          { content: 'Latest', role: 'user' },
        ],
        sessionId: conversation.id,
      }),
    );
  });

  it('passes through streamed error and tool-call-delta chunks while continuing the tool loop', async () => {
    const execute = vi.fn(async (args: JsonObject) => ({
      normalized: args.result ?? null,
    }));
    const stream = vi
      .fn<ConversationClient['stream']>()
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield { error: new Error('intermediate warning'), type: 'error' };
        yield {
          id: 'tool_1',
          name: 'lookup_weather',
          type: 'tool-call-start',
        };
        yield {
          argsDelta: '{"value":"Ber',
          id: 'tool_1',
          type: 'tool-call-delta',
        };
        yield {
          args: { result: 'Berlin' },
          id: 'tool_1',
          name: 'lookup_weather',
          type: 'tool-call-arguments',
        };
        yield {
          finishReason: 'tool_call',
          type: 'done',
          usage: usage(4, 1, 0.01),
        };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield { delta: 'Done.', type: 'text-delta' };
        yield {
          finishReason: 'stop',
          type: 'done',
          usage: usage(2, 1, 0.01),
        };
      });
    const conversation = new Conversation(
      {
        complete: vi.fn(),
        stream,
      },
      {
        model: 'gpt-4o',
        tools: [
          {
            description: 'Tool lookup_weather',
            execute,
            name: 'lookup_weather',
            parameters: {
              properties: {
                result: { type: 'string' },
              },
              required: ['result'],
              type: 'object',
            },
          },
        ],
      },
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of conversation.sendStream('Run the tool.')) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual(
      expect.objectContaining({
        error: expect.any(Error),
        type: 'error',
      }),
    );
    expect(chunks[1]).toEqual(
      expect.objectContaining({
        id: 'tool_1',
        name: 'lookup_weather',
        type: 'tool-call-start',
      }),
    );
    expect(chunks[2]).toEqual(
      expect.objectContaining({
        argsDelta: '{"value":"Ber',
        id: 'tool_1',
        type: 'tool-call-delta',
        version: 3,
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      { result: 'Berlin' },
      expect.objectContaining({
        sessionId: conversation.id,
      }),
    );
  });

  it('exposes a cancel() contract for sendStream()', async () => {
    const conversation = new Conversation(
      {
        complete: vi.fn(),
        stream: vi.fn(({ signal }) =>
          (async function* (): AsyncGenerator<StreamChunk, void, void> {
            await new Promise<void>((_, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  reject(signal.reason ?? new Error('aborted'));
                },
                { once: true },
              );
            });
            yield* [];
          })(),
        ),
      },
      { model: 'gpt-4o' },
    );

    const stream = conversation.sendStream('Cancel me');
    const iterator = stream[Symbol.asyncIterator]();
    const nextChunk = iterator.next();

    stream.cancel(new Error('conversation stream cancelled'));

    await expect(nextChunk).rejects.toThrow('conversation stream cancelled');
  });

  it('does not resolve context or dispatch pre-aborted conversation turns', async () => {
    const reason = new Error('already aborted');
    const controller = new AbortController();
    controller.abort(reason);
    const shouldTrim = vi.fn(async () => true);
    const trim = vi.fn(async (messages: CanonicalMessage[]) => messages);
    const complete = vi.fn<ConversationClient['complete']>();
    const stream = vi.fn<ConversationClient['stream']>();
    const conversation = new Conversation(
      { complete, stream },
      {
        contextManager: { shouldTrim, trim },
        model: 'gpt-4o',
      },
    );

    await expect(
      conversation.send('complete', { signal: controller.signal }),
    ).rejects.toBe(reason);
    await expect(
      (async () => {
        for await (const chunk of conversation.sendStream('stream', {
          signal: controller.signal,
        })) {
          void chunk;
        }
      })(),
    ).rejects.toBe(reason);
    expect(shouldTrim).not.toHaveBeenCalled();
    expect(trim).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('returns structured errors when a called tool has no execute callback', async () => {
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: {},
            id: 'tool_1',
            name: 'missing_tool',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [{ args: {}, id: 'tool_1', name: 'missing_tool' }],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Handled missing tool.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Handled missing tool.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        model: 'gpt-4o',
        tools: [
          {
            description: 'No execute callback',
            name: 'missing_tool',
            parameters: { type: 'object' },
          },
          buildTool(
            'lookup_weather',
            vi.fn(async () => ({ ok: true })),
          ),
        ],
      },
    );

    await conversation.send('Use the missing tool.');

    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            content: [
              {
                isError: true,
                name: 'missing_tool',
                result: {
                  error: {
                    message:
                      'No executable tool registered for "missing_tool".',
                    name: 'Error',
                  },
                },
                toolCallId: 'tool_1',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]),
      }),
    );
  });

  it('returns timeout errors when tool execution exceeds the configured limit', async () => {
    let observedSignal: AbortSignal | undefined;
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: {},
            id: 'tool_1',
            name: 'slow_tool',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: '',
        toolCalls: [{ args: {}, id: 'tool_1', name: 'slow_tool' }],
        usage: usage(4, 1, 0.01),
      })
      .mockResolvedValueOnce({
        content: [{ text: 'Timed out.', type: 'text' }],
        finishReason: 'stop',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        text: 'Timed out.',
        toolCalls: [],
        usage: usage(2, 1, 0.01),
      });
    const conversation = new Conversation(
      {
        complete,
        stream: vi.fn(),
      },
      {
        model: 'gpt-4o',
        toolExecutionTimeoutMs: 1,
        tools: [
          buildTool(
            'slow_tool',
            vi.fn(async (_args, context) => {
              observedSignal = context?.signal;
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { ok: true };
            }),
          ),
        ],
      },
    );

    await conversation.send('Run the slow tool.');

    expect(observedSignal?.aborted).toBe(true);
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          {
            content: [
              {
                isError: true,
                name: 'slow_tool',
                result: {
                  error: {
                    message: 'Tool execution timed out after 1ms.',
                    name: 'Error',
                  },
                },
                toolCallId: 'tool_1',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
        ]),
      }),
    );
  });

  it('rejects nested turns after await and starts nested streams lazily', async () => {
    const nestedErrors: unknown[] = [];
    const execute = vi.fn(async () => {
      await Promise.resolve();
      conversation.sendStream('never-consumed');
      try {
        await collectStream(conversation.sendStream('nested-stream'));
      } catch (error) {
        nestedErrors.push(error);
      }
      try {
        await conversation.send('nested-send');
      } catch (error) {
        nestedErrors.push(error);
      }
      return { ok: true };
    });
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce(toolCallResponse('nested_tool'))
      .mockResolvedValueOnce(response('outer-done'))
      .mockResolvedValueOnce(response('after-done'));
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      { tools: [buildTool('nested_tool', execute)] },
    );

    await conversation.send('outer');

    expect(nestedErrors).toHaveLength(2);
    expect(nestedErrors[0]).toMatchObject({
      details: {
        code: 'conversation_busy',
        operation: 'sendStream',
        reason: 'tool_execution_reentrancy',
      },
      retryable: false,
      statusCode: 409,
    });
    expect(nestedErrors[1]).toMatchObject({
      details: {
        code: 'conversation_busy',
        operation: 'send',
        reason: 'tool_execution_reentrancy',
      },
      retryable: false,
      statusCode: 409,
    });
    expect(complete).toHaveBeenCalledTimes(2);

    await conversation.send('after');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(conversation.history.at(-1)).toEqual({
      content: 'after-done',
      role: 'assistant',
    });
  });

  it('keeps timed-out callbacks guarded through late settlement', async () => {
    const releaseTool = deferred<void>();
    const toolSettled = deferred<void>();
    let nestedError: unknown;
    const execute = vi.fn(async () => {
      try {
        await releaseTool.promise;
        await conversation.send('late-nested');
      } catch (error) {
        nestedError = error;
      } finally {
        toolSettled.resolve();
      }
      return { late: true };
    });
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce(toolCallResponse('slow_nested_tool'))
      .mockResolvedValueOnce(response('outer-after-timeout'))
      .mockResolvedValueOnce(response('ordinary-after-late-settlement'));
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      {
        toolExecutionTimeoutMs: 1,
        tools: [buildTool('slow_nested_tool', execute)],
      },
    );

    await conversation.send('outer');
    const stableHistory = conversation.history;
    const stableTotals = conversation.totals;

    await expect(
      conversation.send('external-during-late-tool'),
    ).rejects.toMatchObject({
      details: {
        code: 'conversation_busy',
        operation: 'send',
        reason: 'tool_execution_reentrancy',
      },
      retryable: false,
      statusCode: 409,
    });
    expect(complete).toHaveBeenCalledTimes(2);

    releaseTool.resolve();
    await toolSettled.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nestedError).toMatchObject({
      details: {
        code: 'conversation_busy',
        operation: 'send',
        reason: 'tool_execution_reentrancy',
      },
      retryable: false,
      statusCode: 409,
    });
    expect(conversation.history).toEqual(stableHistory);
    expect(conversation.totals).toEqual(stableTotals);
    expect(complete).toHaveBeenCalledTimes(2);

    await conversation.send('ordinary');
    expect(conversation.history.at(-1)).toEqual({
      content: 'ordinary-after-late-settlement',
      role: 'assistant',
    });
  });

  it('rejects a send queued before a late tool callback starts', async () => {
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    const toolSettled = deferred<void>();
    const set = vi.fn(async () => undefined);
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockImplementationOnce(async () => {
        providerStarted.resolve();
        await releaseProvider.promise;
        return toolCallResponse('late_tool');
      })
      .mockResolvedValueOnce(response('outer-done'))
      .mockResolvedValueOnce(response('fresh-done'));
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      {
        sessionId: 'queued-before-tool',
        store: { set } as never,
        toolExecutionTimeoutMs: 1,
        tools: [
          buildTool('late_tool', async () => {
            toolStarted.resolve();
            try {
              await releaseTool.promise;
            } finally {
              toolSettled.resolve();
            }
            return { late: true };
          }),
        ],
      },
    );

    const outer = conversation.send('outer');
    await providerStarted.promise;
    const queued = conversation.send('queued-before-tool');
    releaseProvider.resolve();
    await toolStarted.promise;

    const [outerResult, queuedResult] = await Promise.allSettled([
      outer,
      queued,
    ]);
    expect(outerResult.status).toBe('fulfilled');
    expect(queuedResult).toMatchObject({
      reason: {
        details: {
          code: 'conversation_busy',
          operation: 'send',
          reason: 'tool_execution_reentrancy',
        },
        retryable: false,
        statusCode: 409,
      },
      status: 'rejected',
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(1);

    const stableHistory = conversation.history;
    const stableTotals = conversation.totals;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(conversation.history).toEqual(stableHistory);
    expect(conversation.totals).toEqual(stableTotals);
    expect(() => conversation.clear()).toThrowError(
      expect.objectContaining({
        details: { code: 'conversation_busy', operation: 'clear' },
        retryable: false,
        statusCode: 409,
      }),
    );

    releaseTool.resolve();
    await toolSettled.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await conversation.send('fresh');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenCalledTimes(2);
    expect(conversation.history.at(-1)).toEqual({
      content: 'fresh-done',
      role: 'assistant',
    });
  });

  it('rejects a consumed stream queued before a late tool callback starts', async () => {
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    const toolSettled = deferred<void>();
    const stream = vi.fn<ConversationClient['stream']>();
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockImplementationOnce(async () => {
        providerStarted.resolve();
        await releaseProvider.promise;
        return toolCallResponse('late_stream_tool');
      })
      .mockResolvedValueOnce(response('outer-done'))
      .mockResolvedValueOnce(response('fresh-done'));
    const conversation = new Conversation(
      { complete, stream },
      {
        toolExecutionTimeoutMs: 1,
        tools: [
          buildTool('late_stream_tool', async () => {
            toolStarted.resolve();
            try {
              await releaseTool.promise;
            } finally {
              toolSettled.resolve();
            }
            return { late: true };
          }),
        ],
      },
    );

    const outer = conversation.send('outer');
    await providerStarted.promise;
    const queuedStream = collectStream(
      conversation.sendStream('queued-before-tool'),
    );
    releaseProvider.resolve();
    await toolStarted.promise;

    const [outerResult, streamResult] = await Promise.allSettled([
      outer,
      queuedStream,
    ]);
    expect(outerResult.status).toBe('fulfilled');
    expect(streamResult).toMatchObject({
      reason: {
        details: {
          code: 'conversation_busy',
          operation: 'sendStream',
          reason: 'tool_execution_reentrancy',
        },
        retryable: false,
        statusCode: 409,
      },
      status: 'rejected',
    });
    expect(stream).not.toHaveBeenCalled();
    const stableHistory = conversation.history;
    const stableTotals = conversation.totals;

    releaseTool.resolve();
    await toolSettled.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversation.history).toEqual(stableHistory);
    expect(conversation.totals).toEqual(stableTotals);
    await conversation.send('fresh');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(conversation.history.at(-1)).toEqual({
      content: 'fresh-done',
      role: 'assistant',
    });
  });

  it('rejects external sends while a tool callback is active', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce(toolCallResponse('gated_tool'))
      .mockResolvedValueOnce(response('outer-done'))
      .mockResolvedValueOnce(response('after-done'));
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      {
        tools: [
          buildTool('gated_tool', async () => {
            started.resolve();
            await release.promise;
            return { ok: true };
          }),
        ],
      },
    );
    const outer = conversation.send('outer');
    await started.promise;

    await expect(conversation.send('external')).rejects.toMatchObject({
      details: {
        code: 'conversation_busy',
        operation: 'send',
        reason: 'tool_execution_reentrancy',
      },
      retryable: false,
      statusCode: 409,
    });
    expect(complete).toHaveBeenCalledTimes(1);

    release.resolve();
    await outer;
    await conversation.send('after');
    expect(conversation.history.map((message) => message.content)).toEqual([
      'outer',
      expect.any(Array),
      expect.any(Array),
      'outer-done',
      'after',
      'after-done',
    ]);
  });

  it('releases the tool guard after callback errors and aborts', async () => {
    const throwingComplete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce(toolCallResponse('throwing_tool'))
      .mockResolvedValueOnce(response('handled-error'))
      .mockResolvedValueOnce(response('after-error'));
    const throwingConversation = new Conversation(
      { complete: throwingComplete, stream: vi.fn() },
      {
        tools: [
          buildTool('throwing_tool', () => {
            throw new Error('tool failed');
          }),
        ],
      },
    );

    await throwingConversation.send('outer');
    await throwingConversation.send('after');
    expect(throwingComplete).toHaveBeenCalledTimes(3);

    const started = deferred<void>();
    const callbackSettled = deferred<void>();
    const abortComplete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce(toolCallResponse('abortable_tool'))
      .mockResolvedValueOnce(response('after-abort'));
    const abortConversation = new Conversation(
      { complete: abortComplete, stream: vi.fn() },
      {
        tools: [
          buildTool('abortable_tool', async (_args, context) => {
            started.resolve();
            try {
              await new Promise<void>((_, reject) => {
                context?.signal?.addEventListener(
                  'abort',
                  () => reject(context.signal?.reason),
                  { once: true },
                );
              });
            } finally {
              callbackSettled.resolve();
            }
            return null;
          }),
        ],
      },
    );
    const controller = new AbortController();
    const reason = new Error('abort outer tool turn');
    const aborted = abortConversation.send('abort-me', {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    await callbackSettled.promise;
    await Promise.resolve();

    await abortConversation.send('after-abort');
    expect(abortComplete).toHaveBeenCalledTimes(2);
    expect(abortConversation.history).toEqual([
      { content: 'after-abort', role: 'user' },
      { content: 'after-abort', role: 'assistant' },
    ]);
  });

  it.each([2, 10, 100])(
    'serializes %i overlapping sends in FIFO order',
    async (turnCount) => {
      let active = 0;
      let maximumActive = 0;
      const observedMessages: CanonicalMessage[][] = [];
      const complete = vi.fn<ConversationClient['complete']>(
        async ({ messages }) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          observedMessages.push(structuredClone(messages));
          await new Promise((resolve) => setTimeout(resolve, 1));
          const input = messages.at(-1)?.content;
          active -= 1;
          return response(`${String(input)}-reply`);
        },
      );
      const conversation = new Conversation(
        { complete, stream: vi.fn() },
        { sessionId: `fifo-${turnCount}` },
      );
      const inputs = Array.from(
        { length: turnCount },
        (_, index) => `turn-${index}`,
      );

      await Promise.all(inputs.map((input) => conversation.send(input)));

      expect(maximumActive).toBe(1);
      expect(observedMessages).toHaveLength(turnCount);
      expect(observedMessages.map((messages) => messages.length)).toEqual(
        inputs.map((_, index) => index * 2 + 1),
      );
      expect(conversation.history).toEqual(
        inputs.flatMap((input) => [
          { content: input, role: 'user' as const },
          { content: `${input}-reply`, role: 'assistant' as const },
        ]),
      );
      expect(conversation.totals).toMatchObject({
        inputTokens: turnCount,
        outputTokens: turnCount,
      });
    },
  );

  it('serializes send and stream turns in acquisition order', async () => {
    const firstGate = deferred<void>();
    const complete = vi.fn<ConversationClient['complete']>(
      async ({ messages }) => {
        await firstGate.promise;
        return response(`${String(messages.at(-1)?.content)}-reply`);
      },
    );
    const stream = vi.fn<ConversationClient['stream']>(async function* ({
      messages,
    }) {
      const input = String(messages.at(-1)?.content);
      yield { delta: `${input}-reply`, type: 'text-delta' };
      yield {
        finishReason: 'stop',
        type: 'done',
        usage: usage(1, 1, 0.01),
      };
    });
    const conversation = new Conversation({ complete, stream });

    const sent = conversation.send('complete-first');
    const streamed = collectStream(conversation.sendStream('stream-second'));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(stream).not.toHaveBeenCalled();
    firstGate.resolve();
    await Promise.all([sent, streamed]);

    expect(conversation.history).toEqual([
      { content: 'complete-first', role: 'user' },
      { content: 'complete-first-reply', role: 'assistant' },
      { content: 'stream-second', role: 'user' },
      { content: 'stream-second-reply', role: 'assistant' },
    ]);
  });

  it('serializes two streamed turns and releases on iterator return', async () => {
    const stream = vi.fn<ConversationClient['stream']>(async function* ({
      messages,
    }) {
      const input = String(messages.at(-1)?.content);
      yield { delta: `${input}-reply`, type: 'text-delta' };
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield {
        finishReason: 'stop',
        type: 'done',
        usage: usage(1, 1, 0.01),
      };
    });
    const conversation = new Conversation({
      complete: vi.fn(),
      stream,
    });
    const firstIterator = conversation
      .sendStream('stream-first')
      [Symbol.asyncIterator]();
    const firstChunk = await firstIterator.next();
    expect(firstChunk.value).toMatchObject({
      delta: 'stream-first-reply',
      type: 'text-delta',
    });

    const second = collectStream(conversation.sendStream('stream-second'));
    await Promise.resolve();
    expect(stream).toHaveBeenCalledTimes(1);
    await firstIterator.return!();
    await second;

    expect(stream).toHaveBeenCalledTimes(2);
    expect(conversation.history).toEqual([
      { content: 'stream-second', role: 'user' },
      { content: 'stream-second-reply', role: 'assistant' },
    ]);
  });

  it('releases a stream suspended at a yielded chunk when cancel is called', async () => {
    const stream = vi.fn<ConversationClient['stream']>(
      async function* (): AsyncGenerator<StreamChunk, void, void> {
        yield { delta: 'partial', type: 'text-delta' };
        await new Promise(() => undefined);
      },
    );
    const complete = vi.fn<ConversationClient['complete']>(async () =>
      response('after-cancel-reply'),
    );
    const conversation = new Conversation({ complete, stream });
    const active = conversation.sendStream('stream');
    const firstChunk = await active[Symbol.asyncIterator]().next();
    expect(firstChunk.value).toMatchObject({
      delta: 'partial',
      type: 'text-delta',
    });
    const queued = conversation.send('after-cancel');

    active.cancel(new Error('stop suspended stream'));
    await queued;

    expect(conversation.history).toEqual([
      { content: 'after-cancel', role: 'user' },
      { content: 'after-cancel-reply', role: 'assistant' },
    ]);
  });

  it('removes an aborted queued turn without effects and preserves its reason', async () => {
    const firstGate = deferred<void>();
    const complete = vi.fn<ConversationClient['complete']>(
      async ({ messages }) => {
        if (messages.at(-1)?.content === 'first') {
          await firstGate.promise;
        }
        return response(`${String(messages.at(-1)?.content)}-reply`);
      },
    );
    const conversation = new Conversation({ complete, stream: vi.fn() });
    const first = conversation.send('first');
    const controller = new AbortController();
    const reason = new Error('queued turn aborted');
    const aborted = conversation.send('aborted', {
      signal: controller.signal,
    });
    const third = conversation.send('third');

    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    firstGate.resolve();
    await Promise.all([first, third]);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(conversation.history).toEqual([
      { content: 'first', role: 'user' },
      { content: 'first-reply', role: 'assistant' },
      { content: 'third', role: 'user' },
      { content: 'third-reply', role: 'assistant' },
    ]);
  });

  it('releases after provider failure and active stream cancellation', async () => {
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockRejectedValueOnce(new Error('first provider failed'))
      .mockResolvedValueOnce(response('second-reply'))
      .mockResolvedValueOnce(response('after-cancel-reply'));
    const stream = vi.fn<ConversationClient['stream']>(({ signal }) =>
      (async function* () {
        await new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
        yield* [];
      })(),
    );
    const conversation = new Conversation({ complete, stream });

    const failed = conversation.send('first');
    const second = conversation.send('second');
    await expect(failed).rejects.toThrow('first provider failed');
    await second;

    const activeStream = conversation.sendStream('cancelled');
    const next = activeStream[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
    const afterCancel = conversation.send('after-cancel');
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(2);
    activeStream.cancel(new Error('cancel active stream'));
    await expect(next).rejects.toThrow('cancel active stream');
    await afterCancel;

    expect(conversation.history).toEqual([
      { content: 'second', role: 'user' },
      { content: 'second-reply', role: 'assistant' },
      { content: 'after-cancel', role: 'user' },
      { content: 'after-cancel-reply', role: 'assistant' },
    ]);
  });

  it('does not acquire a turn for an unconsumed stream', async () => {
    const stream = vi.fn<ConversationClient['stream']>();
    const complete = vi.fn<ConversationClient['complete']>(async () =>
      response('complete-reply'),
    );
    const conversation = new Conversation({ complete, stream });

    conversation.sendStream('never-consumed');
    await conversation.send('complete');

    expect(stream).not.toHaveBeenCalled();
    expect(conversation.history).toEqual([
      { content: 'complete', role: 'user' },
      { content: 'complete-reply', role: 'assistant' },
    ]);
  });

  it('keeps local state unchanged on persistence failure and runs the next turn', async () => {
    const set = vi
      .fn()
      .mockRejectedValueOnce(new Error('store failed'))
      .mockResolvedValueOnce(undefined);
    const complete = vi.fn<ConversationClient['complete']>(
      async ({ messages }) =>
        response(`${String(messages.at(-1)?.content)}-reply`),
    );
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      { sessionId: 'atomic-persist', store: { set } as never },
    );

    const failed = conversation.send('first');
    const second = conversation.send('second');
    await expect(failed).rejects.toThrow('store failed');
    await second;

    expect(set).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: [{ content: 'second', role: 'user' }],
      }),
    );
    expect(conversation.history).toEqual([
      { content: 'second', role: 'user' },
      { content: 'second-reply', role: 'assistant' },
    ]);
    expect(conversation.totals).toMatchObject({
      costUSD: 0.01,
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it('keeps context, provider, and persistence phases non-overlapping', async () => {
    let active = 0;
    let maximumActive = 0;
    const enter = async (): Promise<void> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    };
    const complete = vi.fn<ConversationClient['complete']>(
      async ({ messages }) => {
        await enter();
        return response(`${String(messages.at(-1)?.content)}-reply`);
      },
    );
    const set = vi.fn(async () => enter());
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      {
        contextManager: {
          shouldTrim: vi.fn(async () => {
            await enter();
            return false;
          }),
          trim: vi.fn(),
        },
        sessionId: 'non-overlap',
        store: { set } as never,
      },
    );

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        conversation.send(`turn-${index}`),
      ),
    );

    expect(maximumActive).toBe(1);
    expect(set).toHaveBeenCalledTimes(10);
  });

  it('holds the FIFO slot across every round of an automatic tool loop', async () => {
    const execute = vi.fn(async () => ({ city: 'Paris', temperature: 21 }));
    const complete = vi
      .fn<ConversationClient['complete']>()
      .mockResolvedValueOnce({
        content: [
          {
            args: { city: 'Paris' },
            id: 'call-1',
            name: 'lookup',
            type: 'tool_call',
          },
        ],
        finishReason: 'tool_call',
        model: 'mock-model',
        provider: 'mock',
        raw: {},
        text: '',
        toolCalls: [{ args: { city: 'Paris' }, id: 'call-1', name: 'lookup' }],
        usage: usage(1, 1, 0.01),
      })
      .mockResolvedValueOnce(response('first-done'))
      .mockResolvedValueOnce(response('second-done'));
    const conversation = new Conversation(
      { complete, stream: vi.fn() },
      { tools: [buildTool('lookup', execute)] },
    );

    await Promise.all([
      conversation.send('first-with-tool'),
      conversation.send('second-after-tool'),
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[2]![0].messages).toEqual(
      expect.arrayContaining([
        { content: 'first-with-tool', role: 'user' },
        { content: 'first-done', role: 'assistant' },
        { content: 'second-after-tool', role: 'user' },
      ]),
    );
    expect(conversation.history.at(-1)).toEqual({
      content: 'second-done',
      role: 'assistant',
    });
  });

  it('rejects clear while a turn is active without corrupting history', async () => {
    const gate = deferred<void>();
    const conversation = new Conversation({
      complete: vi.fn(async () => {
        await gate.promise;
        return response('reply');
      }),
      stream: vi.fn(),
    });
    const pending = conversation.send('turn');

    expect(() => conversation.clear()).toThrowError(
      expect.objectContaining({
        details: { code: 'conversation_busy', operation: 'clear' },
        statusCode: 409,
      }),
    );
    gate.resolve();
    await pending;
    expect(conversation.history).toHaveLength(2);
  });
});

describe('Conversation stream event contract', () => {
  it('resolves defaults before dispatching streamed tools and correlates context rounds', async () => {
    const usage = {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: 1,
      outputTokens: 1,
    };
    const stream = vi
      .fn<ConversationClient['stream']>()
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield {
          model: 'resolved-model',
          provider: 'mock',
          type: 'response-start',
        };
        yield { id: 'call-1', name: 'lookup', type: 'tool-call-start' };
        yield {
          args: { city: 'Berlin' },
          id: 'call-1',
          name: 'lookup',
          type: 'tool-call-arguments',
        };
        yield { finishReason: 'tool_call', type: 'done', usage };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield {
          model: 'resolved-model',
          provider: 'mock',
          type: 'response-start',
        };
        yield { delta: 'Done.', type: 'text-delta' };
        yield { finishReason: 'stop', type: 'done', usage };
      });
    const dispatcher = vi.fn(async () => ({ temperature: 20 }));
    const contextRounds: Array<{
      model?: string;
      provider?: string;
      requestId?: string;
      toolRound?: number;
    }> = [];
    const conversation = new Conversation(
      {
        complete: vi.fn(),
        resolveContext: () => ({
          contextWindow: 4096,
          model: 'resolved-model',
          provider: 'mock',
        }),
        stream,
      },
      {
        contextManager: {
          shouldTrim: vi.fn((_messages, context) => {
            contextRounds.push(context);
            return false;
          }),
          trim: vi.fn(),
        },
        sessionId: 'implicit-stream-dispatch',
        toolCallDispatcher: { execute: dispatcher },
        tools: [
          {
            description: 'Look up a city',
            name: 'lookup',
            parameters: {
              properties: { city: { type: 'string' } },
              type: 'object',
            },
          },
        ],
      },
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of conversation.sendStream('Look up Berlin.', {
      metadata: { source: 'conversation-test' },
      requestId: 'caller-request-456',
    })) {
      chunks.push(chunk);
    }

    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        call: { args: { city: 'Berlin' }, id: 'call-1', name: 'lookup' },
        model: 'resolved-model',
        provider: 'mock',
      }),
    );
    expect(stream).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metadata: { source: 'conversation-test' },
        model: 'resolved-model',
        provider: 'mock',
        requestId: 'caller-request-456',
      }),
    );
    expect(stream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        metadata: { source: 'conversation-test' },
        requestId: 'caller-request-456',
      }),
    );
    expect(contextRounds.map((context) => context.toolRound)).toEqual([0, 1]);
    expect(contextRounds).toEqual([
      expect.objectContaining({
        contextWindow: 4096,
        model: 'resolved-model',
        provider: 'mock',
        requestId: 'caller-request-456',
        toolRound: 0,
      }),
      expect.objectContaining({
        model: 'resolved-model',
        provider: 'mock',
        requestId: 'caller-request-456',
        toolRound: 1,
      }),
    ]);
    expect(conversation.serialise()).toEqual(
      expect.objectContaining({
        model: 'resolved-model',
        provider: 'mock',
      }),
    );
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({ finishReason: 'stop', type: 'done' }),
    );
  });

  it('keeps v2 metadata monotonic across automatic tool-loop rounds', async () => {
    const usage = {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: 1,
      outputTokens: 1,
    };
    const stream = vi
      .fn<ConversationClient['stream']>()
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield {
          model: 'mock-model',
          provider: 'mock',
          sequence: 1,
          timestamp: '2020-01-01T00:00:00.000Z',
          type: 'response-start',
          version: 3,
        };
        yield {
          id: 'call-1',
          name: 'weather',
          sequence: 2,
          timestamp: '2020-01-01T00:00:00.001Z',
          type: 'tool-call-start',
          version: 3,
        };
        yield {
          args: { city: 'Paris' },
          id: 'call-1',
          name: 'weather',
          sequence: 3,
          timestamp: '2020-01-01T00:00:00.002Z',
          type: 'tool-call-arguments',
          version: 3,
        };
        yield {
          finishReason: 'tool_call',
          sequence: 4,
          timestamp: '2020-01-01T00:00:00.003Z',
          type: 'done',
          usage,
          version: 3,
        };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<
        StreamChunk,
        void,
        void
      > {
        yield {
          model: 'mock-model',
          provider: 'mock',
          sequence: 1,
          timestamp: '2020-01-01T00:00:01.000Z',
          type: 'response-start',
          version: 3,
        };
        yield {
          delta: 'done',
          sequence: 2,
          timestamp: '2020-01-01T00:00:01.001Z',
          type: 'text-delta',
          version: 3,
        };
        yield {
          finishReason: 'stop',
          sequence: 3,
          timestamp: '2020-01-01T00:00:01.002Z',
          type: 'done',
          usage,
          version: 3,
        };
      });
    const conversation = new Conversation(
      { complete: vi.fn(), stream },
      {
        model: 'mock-model',
        provider: 'mock',
        tools: [
          {
            description: 'Get weather',
            execute: async () => ({ temperature: 20 }),
            name: 'weather',
            parameters: {
              properties: { city: { type: 'string' } },
              required: ['city'],
              type: 'object',
            },
          },
        ],
      },
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of conversation.sendStream('weather', {
      requestId: 'conversation-request',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.sequence)).toEqual(
      chunks.map((_, index) => index + 1),
    );
    expect(chunks.every((chunk) => chunk.version === 3)).toBe(true);
    expect(
      chunks.every((chunk) => chunk.requestId === 'conversation-request'),
    ).toBe(true);
    expect(chunks.every((chunk) => typeof chunk.timestamp === 'string')).toBe(
      true,
    );
    expect(chunks.filter((chunk) => chunk.type === 'done')).toHaveLength(1);
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        finishReason: 'stop',
        requestId: 'conversation-request',
        type: 'done',
        version: 3,
      }),
    );
    expect(stream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestId: 'conversation-request' }),
    );
  });
});

describe('SlidingWindowStrategy', () => {
  it('validates discrete maxMessages and maxTokens limits', () => {
    const valid = [0, 1, 2, 10_000];
    const invalid = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const option of ['maxMessages', 'maxTokens'] as const) {
      for (const value of valid) {
        expect(
          () => new SlidingWindowStrategy({ [option]: value }),
        ).not.toThrow();
      }
      for (const value of invalid) {
        expect(() => new SlidingWindowStrategy({ [option]: value })).toThrow(
          ProviderCapabilityError,
        );
      }
      for (const value of ['1', null]) {
        expect(
          () =>
            new SlidingWindowStrategy({
              [option]: value,
            } as unknown as ConstructorParameters<
              typeof SlidingWindowStrategy
            >[0]),
        ).toThrow(ProviderCapabilityError);
      }
    }
  });

  it('reports sanitized structured validation details', () => {
    let error: unknown;
    try {
      new SlidingWindowStrategy({ maxMessages: Number.NaN });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ProviderCapabilityError);
    expect(error).toEqual(
      expect.objectContaining({
        details: {
          constraint: 'finite_non_negative_integer',
          option: 'maxMessages',
          value: 'NaN',
        },
        statusCode: 400,
      }),
    );
  });

  it('validates token estimator results from shouldTrim and trim', () => {
    const messages: CanonicalMessage[] = [{ content: 'Latest', role: 'user' }];
    const invalid = [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      '1',
      null,
      1n,
      Promise.resolve(1),
    ];

    for (const estimatedTokens of invalid) {
      const strategy = new SlidingWindowStrategy({
        maxTokens: 1,
        tokenEstimator: () => estimatedTokens as number,
      });
      expect(() => strategy.shouldTrim(messages, {})).toThrow(
        ProviderCapabilityError,
      );
      expect(() => strategy.trim(messages, {})).toThrow(
        ProviderCapabilityError,
      );
    }

    for (const estimatedTokens of [0, 0.5]) {
      const strategy = new SlidingWindowStrategy({
        maxTokens: 1,
        tokenEstimator: () => estimatedTokens,
      });
      expect(strategy.shouldTrim(messages, {})).toBe(false);
      expect(strategy.trim(messages, {})).toEqual(messages);
    }
  });

  it('preserves the exact token estimator exception', () => {
    const sentinel = new Error('estimator sentinel');
    const strategy = new SlidingWindowStrategy({
      maxTokens: 1,
      tokenEstimator: () => {
        throw sentinel;
      },
    });
    const messages: CanonicalMessage[] = [{ content: 'Latest', role: 'user' }];

    for (const operation of [
      () => strategy.shouldTrim(messages, {}),
      () => strategy.trim(messages, {}),
    ]) {
      let error: unknown;
      try {
        operation();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBe(sentinel);
    }
  });

  it('validates the final onTrim estimate before invoking the callback', () => {
    const onTrim = vi.fn();
    const tokenEstimator = vi
      .fn()
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(Number.NaN);
    const strategy = new SlidingWindowStrategy({
      maxTokens: 1,
      onTrim,
      tokenEstimator,
    });

    expect(() =>
      strategy.trim(
        [
          { content: 'Old', role: 'assistant' },
          { content: 'Latest', role: 'user' },
        ],
        {},
      ),
    ).toThrow(ProviderCapabilityError);
    expect(onTrim).not.toHaveBeenCalled();
  });

  it('uses the model context window after reserving output and tool schema tokens', () => {
    const strategy = new SlidingWindowStrategy({
      tokenEstimator: (messages) => messages.length * 10,
    });
    const messages: CanonicalMessage[] = [
      { content: 'One', role: 'user' },
      { content: 'Two', role: 'assistant' },
      { content: 'Three', role: 'user' },
      { content: 'Four', role: 'assistant' },
      { content: 'Latest', role: 'user' },
    ];

    expect(
      strategy.shouldTrim(messages, {
        contextWindow: 90,
        estimatedToolSchemaTokens: 20,
        reservedOutputTokens: 30,
      }),
    ).toBe(true);
    expect(
      strategy.shouldTrim(messages.slice(-4), {
        contextWindow: 90,
        estimatedToolSchemaTokens: 20,
        reservedOutputTokens: 30,
      }),
    ).toBe(false);
  });

  it('preserves complete tool-call and tool-result exchanges while trimming', () => {
    const strategy = new SlidingWindowStrategy({
      maxMessages: 3,
    });
    const messages: CanonicalMessage[] = [
      { content: 'Old user', role: 'user' },
      {
        content: [
          {
            args: { city: 'Paris' },
            id: 'call-1',
            name: 'weather',
            type: 'tool_call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            name: 'weather',
            result: { temperature: 20 },
            toolCallId: 'call-1',
            type: 'tool_result',
          },
        ],
        role: 'user',
      },
      { content: 'Latest user', role: 'user' },
    ];

    expect(strategy.trim(messages, {})).toEqual(messages.slice(1));
  });

  it('trims the oldest removable messages while preserving pinned and latest user content', () => {
    const strategy = new SlidingWindowStrategy({
      maxMessages: 2,
    });
    const messages: CanonicalMessage[] = [
      { content: 'Pinned context', pinned: true, role: 'user' },
      { content: 'Old assistant', role: 'assistant' },
      { content: 'Latest user', role: 'user' },
    ];

    const trimmed = strategy.trim(messages, {});

    expect(trimmed).toEqual([
      { content: 'Pinned context', pinned: true, role: 'user' },
      { content: 'Latest user', role: 'user' },
    ]);
  });

  it('evaluates token-based trimming with system prompts and reports trim events', () => {
    const onTrim = vi.fn();
    const strategy = new SlidingWindowStrategy({
      maxTokens: 10,
      onTrim,
      tokenEstimator: (messages) => messages.length * 6,
    });
    const messages: CanonicalMessage[] = [
      { content: 'First', role: 'user' },
      { content: 'Second', role: 'assistant' },
      { content: 'Third', role: 'user' },
    ];

    expect(strategy.shouldTrim(messages, { system: 'System' })).toBe(true);
    expect(strategy.trim(messages, { system: 'System' })).toEqual([
      { content: 'Third', role: 'user' },
    ]);
    expect(onTrim).toHaveBeenCalledWith({
      afterCount: 1,
      beforeCount: 3,
      estimatedTokens: 12,
      removedCount: 2,
    });
  });

  it('does not trim when every message is pinned or the latest user turn', () => {
    const strategy = new SlidingWindowStrategy({
      maxMessages: 1,
    });
    const messages: CanonicalMessage[] = [
      { content: 'Pinned', pinned: true, role: 'assistant' },
      { content: 'Latest user', role: 'user' },
    ];

    expect(strategy.shouldTrim(messages, {})).toBe(true);
    expect(strategy.trim(messages, {})).toEqual(messages);
  });

  it('returns false from shouldTrim when no limits are configured', () => {
    const strategy = new SlidingWindowStrategy();

    expect(strategy.shouldTrim([{ content: 'Hello', role: 'user' }], {})).toBe(
      false,
    );
  });
});

describe('SummarisationStrategy', () => {
  it('validates keepLastMessages and keeps the default at two', async () => {
    for (const keepLastMessages of [0, 1, 2, 99, 1_000_000_000]) {
      expect(
        () =>
          new SummarisationStrategy({
            keepLastMessages,
            summarizer: vi.fn(),
          }),
      ).not.toThrow();
    }

    for (const keepLastMessages of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '1' as unknown as number,
      null as unknown as number,
    ]) {
      const summarizer = vi.fn();
      expect(
        () =>
          new SummarisationStrategy({
            keepLastMessages,
            summarizer,
          }),
      ).toThrow(ProviderCapabilityError);
      expect(summarizer).not.toHaveBeenCalled();
    }

    const summarizer = vi.fn(async () => 'Default summary');
    const strategy = new SummarisationStrategy({
      maxMessages: 4,
      summarizer,
    });
    const messages: CanonicalMessage[] = [
      { content: 'Old user', role: 'user' },
      { content: 'Old assistant', role: 'assistant' },
      { content: 'Middle user', role: 'user' },
      { content: 'Recent assistant', role: 'assistant' },
      { content: 'Latest user', role: 'user' },
    ];

    await strategy.trim(messages, {});
    expect(summarizer).toHaveBeenCalledWith(messages.slice(0, 2), {});
  });

  it('inherits token-estimator validation before invoking the summarizer', async () => {
    const summarizer = vi.fn(async () => 'Summary');
    const strategy = new SummarisationStrategy({
      maxTokens: 1,
      summarizer,
      tokenEstimator: () => Number.NaN,
    });

    await expect(
      strategy.trim([{ content: 'Latest', role: 'user' }], {}),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('summarises tool-call and tool-result exchanges atomically', async () => {
    const summarizer = vi.fn(async () => 'Atomic summary');
    const strategy = new SummarisationStrategy({
      keepLastMessages: 0,
      maxMessages: 2,
      summarizer,
    });
    const messages: CanonicalMessage[] = [
      { content: 'Old user', role: 'user' },
      {
        content: [
          {
            args: { city: 'Paris' },
            id: 'call-1',
            name: 'weather',
            type: 'tool_call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            name: 'weather',
            result: { temperature: 20 },
            toolCallId: 'call-1',
            type: 'tool_result',
          },
        ],
        role: 'user',
      },
      { content: 'Latest user', role: 'user' },
    ];

    const trimmed = await strategy.trim(messages, {});

    expect(summarizer).toHaveBeenCalledWith(messages.slice(0, 3), {});
    expect(trimmed).toEqual([
      {
        content: 'Atomic summary',
        metadata: { summarizedMessageCount: 3, summary: true },
        role: 'assistant',
      },
      { content: 'Latest user', role: 'user' },
    ]);
  });

  it('replaces older removable messages with a generated summary', async () => {
    const summarizer = vi.fn(async (messages: CanonicalMessage[]) => {
      return `Summary of ${messages.length} messages`;
    });
    const strategy = new SummarisationStrategy({
      keepLastMessages: 1,
      maxMessages: 3,
      summarizer,
    });
    const messages: CanonicalMessage[] = [
      { content: 'Old user', role: 'user' },
      { content: 'Old assistant', role: 'assistant' },
      { content: 'Middle user', role: 'user' },
      { content: 'Recent assistant', role: 'assistant' },
      { content: 'Latest user', role: 'user' },
    ];

    const trimmed = await strategy.trim(messages, {});

    expect(summarizer).toHaveBeenCalledWith(messages.slice(0, 3), {});
    expect(trimmed).toEqual([
      {
        content: 'Summary of 3 messages',
        metadata: {
          summarizedMessageCount: 3,
          summary: true,
        },
        role: 'assistant',
      },
      { content: 'Recent assistant', role: 'assistant' },
      { content: 'Latest user', role: 'user' },
    ]);
  });

  it('supports repeated summary cycles by folding earlier summaries back in', async () => {
    const summarizer = vi
      .fn()
      .mockResolvedValueOnce('Summary round 1')
      .mockResolvedValueOnce('Summary round 2');
    const strategy = new SummarisationStrategy({
      keepLastMessages: 1,
      maxMessages: 3,
      summarizer,
    });

    const firstPass = await strategy.trim(
      [
        { content: 'User one', role: 'user' },
        { content: 'Assistant one', role: 'assistant' },
        { content: 'User two', role: 'user' },
        { content: 'Assistant two', role: 'assistant' },
        { content: 'Latest user', role: 'user' },
      ],
      {},
    );
    const secondPass = await strategy.trim(
      [
        ...firstPass,
        { content: 'Assistant three', role: 'assistant' },
        { content: 'Newest user', role: 'user' },
      ],
      {},
    );

    expect(summarizer).toHaveBeenCalledTimes(2);
    expect(secondPass).toEqual([
      {
        content: 'Summary round 2',
        metadata: {
          summarizedMessageCount: 3,
          summary: true,
        },
        role: 'assistant',
      },
      { content: 'Assistant three', role: 'assistant' },
      { content: 'Newest user', role: 'user' },
    ]);
  });
});

describe('InMemorySessionStore', () => {
  it('stores, lists, and deletes tenant-scoped records', async () => {
    const store = new InMemorySessionStore<{
      messages: unknown[];
      totalCostUSD: number;
    }>({
      now: () => new Date('2026-04-15T12:00:00.000Z'),
    });

    await store.set(
      'session-a',
      {
        messages: [{ role: 'user', content: 'Hello' }],
        totalCostUSD: 0.5,
      },
      {
        model: 'gpt-4o',
        provider: 'openai',
        tenantId: 'tenant-1',
      },
    );

    const record = await store.get('session-a', 'tenant-1');
    const list = await store.list({ tenantId: 'tenant-1' });
    await store.delete('session-a', 'tenant-1');

    expect(record?.meta.sessionId).toBe('session-a');
    expect(record?.meta.tenantId).toBe('tenant-1');
    expect(list).toHaveLength(1);
    expect(await store.get('session-a', 'tenant-1')).toBeNull();
  });

  it('returns null for missing records and preserves existing metadata on update', async () => {
    const store = new InMemorySessionStore<{
      messages: unknown[];
      totalCostUSD: number;
    }>({
      now: () => new Date('2026-04-15T13:00:00.000Z'),
    });

    expect(await store.get('missing')).toBeNull();

    await store.set(
      'session-b',
      {
        messages: [{ role: 'user', content: 'Hello' }],
        totalCostUSD: 1,
      },
      {
        createdAt: '2026-04-14T00:00:00.000Z',
        model: 'gpt-4o',
        provider: 'openai',
        tenantId: 'tenant-2',
      },
    );

    const updated = await store.set(
      'session-b',
      {
        messages: [{ role: 'assistant', content: 'Updated' }],
        totalCostUSD: 2,
      },
      {
        tenantId: 'tenant-2',
      },
    );

    expect(updated.meta.createdAt).toBe('2026-04-14T00:00:00.000Z');
    expect(updated.meta.model).toBe('gpt-4o');
    expect(updated.meta.provider).toBe('openai');
    expect(updated.meta.tenantId).toBe('tenant-2');
    expect(updated.meta.messageCount).toBe(1);
    expect(updated.meta.totalCostUSD).toBe(2);
  });

  it('validates conversation metadata before state or client mutation', async () => {
    const complete = vi.fn();
    const stream = vi.fn();
    const client: ConversationClient = { complete, stream };
    const conversation = new Conversation(client);
    const getter = vi.fn(() => 'secret');
    const metadata = {};
    Object.defineProperty(metadata, 'secret', {
      enumerable: true,
      get: getter,
    });

    await expect(
      conversation.send('hello', {
        metadata: metadata as Record<string, never>,
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(() =>
      conversation.sendStream('hello', {
        metadata: { invalid: Symbol('no') } as unknown as Record<string, never>,
      }),
    ).toThrow(ProviderCapabilityError);

    expect(conversation.history).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it('isolates valid conversation metadata from later caller mutation', async () => {
    let capturedMetadata: unknown;
    const client: ConversationClient = {
      complete: vi.fn(async (options) => {
        capturedMetadata = options.metadata;
        return {
          content: [],
          finishReason: 'stop' as const,
          model: 'mock-model',
          provider: 'mock' as const,
          raw: {},
          text: '',
          toolCalls: [],
          usage: usage(0, 0, 0),
        };
      }),
      stream: vi.fn(),
    };
    const conversation = new Conversation(client);
    const nested = { enabled: true };
    const metadata = { nested };

    await conversation.send('hello', { metadata });
    nested.enabled = false;

    expect(capturedMetadata).toEqual({ nested: { enabled: true } });
    expect(capturedMetadata).not.toBe(metadata);
  });

  it('accepts a v2 tool result only as an internal argument alias', async () => {
    const execute = vi.fn(async () => ({ temperature: 21 }));
    const stream = vi
      .fn<ConversationClient['stream']>()
      .mockImplementationOnce(async function* () {
        yield {
          id: 'legacy-call',
          name: 'weather',
          type: 'tool-call-start' as const,
        };
        yield {
          id: 'legacy-call',
          name: 'weather',
          result: { city: 'Paris' },
          type: 'tool-call-result' as const,
          version: 2 as const,
        } as unknown as StreamChunk;
        yield {
          finishReason: 'tool_call' as const,
          type: 'done' as const,
          usage: usage(1, 1, 0),
        };
      })
      .mockImplementationOnce(async function* () {
        yield { delta: '21 C', type: 'text-delta' as const };
        yield {
          finishReason: 'stop' as const,
          type: 'done' as const,
          usage: usage(1, 1, 0),
        };
      });
    const conversation = new Conversation(
      { complete: vi.fn(), stream },
      { tools: [buildTool('weather', execute)] },
    );
    const chunks: StreamChunk[] = [];

    for await (const chunk of conversation.sendStream('weather')) {
      chunks.push(chunk);
    }

    expect(execute).toHaveBeenCalledWith({ city: 'Paris' }, expect.any(Object));
    expect(chunks.filter((chunk) => chunk.type === 'tool-call-result')).toEqual(
      [
        expect.objectContaining({
          id: 'legacy-call',
          isError: false,
          result: { temperature: 21 },
          version: 3,
        }),
      ],
    );
    expect(chunks.some((chunk) => chunk.type === 'tool-call-arguments')).toBe(
      false,
    );
  });

  it.each([
    [
      'orphan delta',
      [
        { argsDelta: '{}', id: 'missing', type: 'tool-call-delta' },
      ] satisfies StreamChunk[],
    ],
    [
      'duplicate start',
      [
        { id: 'call', name: 'weather', type: 'tool-call-start' },
        { id: 'call', name: 'weather', type: 'tool-call-start' },
      ] satisfies StreamChunk[],
    ],
    [
      'incomplete arguments',
      [
        { id: 'call', name: 'weather', type: 'tool-call-start' },
        {
          finishReason: 'tool_call',
          type: 'done',
          usage: usage(1, 1, 0),
        },
      ] satisfies StreamChunk[],
    ],
    [
      'unversioned premature provider result',
      [
        { id: 'call', name: 'weather', type: 'tool-call-start' },
        {
          id: 'call',
          name: 'weather',
          result: { city: 'Paris' },
          type: 'tool-call-result',
        },
      ] satisfies StreamChunk[],
    ],
    [
      'mismatched name',
      [
        { id: 'call', name: 'weather', type: 'tool-call-start' },
        {
          args: { city: 'Paris' },
          id: 'call',
          name: 'other',
          type: 'tool-call-arguments',
        },
      ] satisfies StreamChunk[],
    ],
  ])(
    'rejects sanitized invalid tool stream state: %s',
    async (_name, chunks) => {
      const execute = vi.fn(async () => ({ temperature: 21 }));
      const conversation = new Conversation(
        {
          complete: vi.fn(),
          stream: vi.fn(async function* () {
            yield* chunks;
          }),
        },
        { tools: [buildTool('weather', execute)] },
      );

      const error = await (async () => {
        try {
          for await (const chunk of conversation.sendStream('weather')) {
            void chunk;
          }
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        details: {
          code: 'invalid_provider_response',
          operation: 'stream',
          path: 'tool_calls',
        },
        retryable: false,
        statusCode: 502,
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );
});

function buildTool(
  name: string,
  execute: (
    args: JsonObject,
    context?: ToolExecutionContext,
  ) => JsonValue | Promise<JsonValue>,
): CanonicalTool {
  return {
    description: `Tool ${name}`,
    execute,
    name,
    parameters: {
      properties: {
        city: { type: 'string' as const },
      },
      type: 'object' as const,
    },
  };
}

function usage(inputTokens: number, outputTokens: number, costUSD: number) {
  return {
    cachedTokens: 0,
    cost: `$${costUSD.toFixed(2)}`,
    costUSD,
    inputTokens,
    outputTokens,
  };
}

function validSnapshot(): ConversationSnapshot {
  return {
    createdAt: '2026-04-15T10:00:00.000Z',
    messages: [],
    sessionId: 'valid-session',
    totalCachedTokens: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    updatedAt: '2026-04-15T10:00:00.000Z',
  };
}

function response(text: string): CanonicalResponse {
  return {
    content: [{ text, type: 'text' }],
    finishReason: 'stop',
    model: 'mock-model',
    provider: 'mock',
    raw: {},
    text,
    toolCalls: [],
    usage: usage(1, 1, 0.01),
  };
}

function toolCallResponse(name: string): CanonicalResponse {
  return {
    content: [
      {
        args: {},
        id: 'tool_1',
        name,
        type: 'tool_call',
      },
    ],
    finishReason: 'tool_call',
    model: 'mock-model',
    provider: 'mock',
    raw: {},
    text: '',
    toolCalls: [{ args: {}, id: 'tool_1', name }],
    usage: usage(1, 1, 0.01),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function collectStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
