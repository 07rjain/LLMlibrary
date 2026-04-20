import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMockState = vi.hoisted(() => {
  return {
    createdPools: [] as unknown[],
    poolConstructor: vi.fn(),
  };
});

vi.mock('pg', () => {
  return {
    Pool: pgMockState.poolConstructor,
  };
});

import {
  AuthenticationError,
  BudgetExceededError,
  ProviderCapabilityError,
} from '../src/errors.js';
import { LLMClient } from '../src/client.js';
import { ModelRouter } from '../src/router.js';
import { InMemorySessionStore } from '../src/session-store.js';

import type { ConversationSnapshot } from '../src/conversation.js';
import type { CanonicalResponse, StreamChunk } from '../src/types.js';

const createdPools = pgMockState.createdPools as MockPool[];

describe('LLMClient - Core Functionality', () => {
  beforeEach(() => {
    createdPools.length = 0;
    pgMockState.poolConstructor.mockClear();
    pgMockState.poolConstructor.mockImplementation((options?: unknown) => {
      const pool = new MockPool(options);
      createdPools.push(pool);
      return pool;
    });
    delete process.env.DATABASE_URL;
  });

  describe('Model Registry', () => {
    it('should update prices through the public client API', () => {
      const client = new LLMClient();
      client.updatePrices({
        'gpt-4o': {
          inputPrice: 3.5,
        },
      });
      expect(client.models.get('gpt-4o').inputPrice).toBe(3.5);
    });

    it('should proxy model registry methods', () => {
      const client = new LLMClient();
      client.models.register({
        contextWindow: 64000,
        id: 'custom-model',
        inputPrice: 1,
        lastUpdated: '2026-04-15',
        outputPrice: 2,
        provider: 'mock',
        supportsStreaming: true,
        supportsTools: false,
        supportsVision: false,
      });
      expect(client.models.get('custom-model').provider).toBe('mock');
      expect(client.models.list().some((model) => model.id === 'custom-model')).toBe(true);
    });

    it('should list all registered models', () => {
      const client = new LLMClient();
      const models = client.models.list();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'gpt-4o')).toBe(true);
      expect(models.some((m) => m.id === 'claude-sonnet-4-6')).toBe(true);
    });
  });

  describe('Provider Routing', () => {
    it('should route complete() calls to Anthropic by model', async () => {
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('anthropic')) {
          return new Response(
            JSON.stringify({
              content: [{ text: 'Anthropic response', type: 'text' }],
              id: 'msg_1',
              model: 'claude-sonnet-4-6',
              role: 'assistant',
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          );
        }
        return new Response('unexpected', { status: 500 });
      });

      const client = new LLMClient({
        anthropicApiKey: 'anthropic-key',
        defaultModel: 'claude-sonnet-4-6',
        fetchImplementation,
      });

      const response = await client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      });

      expect(response.provider).toBe('anthropic');
      expect(response.text).toBe('Anthropic response');
    });

    it('should route complete() calls to OpenAI by model', async () => {
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
                    text: 'OpenAI response',
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
            usage: { input_tokens: 5, output_tokens: 3 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const client = new LLMClient({
        defaultModel: 'gpt-4o',
        fetchImplementation,
        openaiApiKey: 'openai-key',
      });

      const response = await client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      });

      expect(response.provider).toBe('openai');
      expect(response.text).toBe('OpenAI response');
    });

    it('should route complete() calls to Gemini by model', async () => {
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: 'Gemini response' }], role: 'model' },
                  finishReason: 'STOP',
                  index: 0,
                },
              ],
              usageMetadata: { candidatesTokenCount: 5, promptTokenCount: 10 },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          );
        }
        return new Response('unexpected', { status: 500 });
      });

      const client = new LLMClient({
        defaultModel: 'gemini-2.5-flash',
        fetchImplementation,
        geminiApiKey: 'gemini-key',
      });

      const response = await client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      });

      expect(response.provider).toBe('google');
      expect(response.text).toBe('Gemini response');
    });
  });

  describe('Streaming', () => {
    it('should route stream() calls to OpenAI by model', async () => {
      const fetchImplementation = vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    content_index: 0,
                    delta: 'Hi',
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
                              text: 'Hi',
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
                      usage: { input_tokens: 5, output_tokens: 3 },
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

      const client = new LLMClient({
        defaultModel: 'gpt-4o',
        fetchImplementation,
        openaiApiKey: 'openai-key',
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of client.stream({
        messages: [{ content: 'Hello', role: 'user' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ delta: 'Hi', type: 'text-delta' });
      expect(chunks.at(-1)).toEqual(expect.objectContaining({ finishReason: 'stop', type: 'done' }));
    });

    it('should route stream() calls to Gemini by model', async () => {
      const fetchImplementation = vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    candidates: [
                      { content: { parts: [{ text: 'Hello from Gemini' }], role: 'model' }, finishReason: 'STOP', index: 0 },
                    ],
                    usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 5 },
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' }, status: 200 },
        ),
      );

      const client = new LLMClient({
        defaultModel: 'gemini-2.5-flash',
        fetchImplementation,
        geminiApiKey: 'gemini-key',
      });

      const chunks: StreamChunk[] = [];
      for await (const chunk of client.stream({
        messages: [{ content: 'Hello', role: 'user' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ delta: 'Hello from Gemini', type: 'text-delta' });
      expect(chunks.at(-1)).toEqual(expect.objectContaining({ finishReason: 'stop', type: 'done' }));
    });
  });

  describe('Environment Configuration', () => {
    it('should load API keys from env via fromEnv()', async () => {
      const originalOpenAIKey = process.env.OPENAI_API_KEY;
      const originalDatabaseUrl = process.env.DATABASE_URL;
      process.env.OPENAI_API_KEY = 'env-openai-key';
      delete process.env.DATABASE_URL;

      try {
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
                      text: 'Env response',
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
              usage: { input_tokens: 5, output_tokens: 3 },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          ),
        );

        const client = LLMClient.fromEnv({ defaultModel: 'gpt-4o', fetchImplementation });
        const response = await client.complete({ messages: [{ content: 'Hello', role: 'user' }] });
        const request = fetchImplementation.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
        const headers = request[1].headers as Record<string, string>;

        expect(response.text).toBe('Env response');
        expect(headers.Authorization).toBe('Bearer env-openai-key');
      } finally {
        process.env.OPENAI_API_KEY = originalOpenAIKey;
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    });
  });

  describe('Error Handling', () => {
    it('should throw on missing API keys', async () => {
      const openaiClient = new LLMClient({ defaultModel: 'gpt-4o', openaiApiKey: '' });
      const geminiClient = new LLMClient({ defaultModel: 'gemini-2.5-flash', geminiApiKey: '' });
      const anthropicClient = new LLMClient({ anthropicApiKey: '', defaultModel: 'claude-sonnet-4-6' });

      await expect(
        openaiClient.complete({ messages: [{ content: 'Hello', role: 'user' }] }),
      ).rejects.toBeInstanceOf(AuthenticationError);

      await expect(
        anthropicClient.complete({ messages: [{ content: 'Hello', role: 'user' }] }),
      ).rejects.toBeInstanceOf(AuthenticationError);

      await expect(
        geminiClient.complete({ messages: [{ content: 'Hello', role: 'user' }] }),
      ).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('should throw on provider/model mismatches', async () => {
      const mismatchClient = new LLMClient({
        anthropicApiKey: 'anthropic-key',
        defaultModel: 'claude-sonnet-4-6',
      });

      await expect(
        mismatchClient.complete({ messages: [{ content: 'Hello', role: 'user' }], provider: 'openai' }),
      ).rejects.toBeInstanceOf(ProviderCapabilityError);
    });

    it('should throw if no model is configured', async () => {
      const client = new LLMClient();
      await expect(
        client.complete({ messages: [{ content: 'Hello', role: 'user' }] }),
      ).rejects.toBeInstanceOf(ProviderCapabilityError);
    });

    it('should throw for unimplemented providers', async () => {
      const client = new LLMClient();
      client.models.register({
        contextWindow: 64000,
        id: 'mock-llm',
        inputPrice: 1,
        lastUpdated: '2026-04-15',
        outputPrice: 2,
        provider: 'mock',
        supportsStreaming: true,
        supportsTools: false,
        supportsVision: false,
      });

      await expect(
        client.complete({ messages: [{ content: 'Hello', role: 'user' }], model: 'mock-llm' }),
      ).rejects.toBeInstanceOf(ProviderCapabilityError);
    });
  });

  describe('Budget Guards', () => {
    it('should enforce per-call budget guards before dispatching requests', async () => {
      const fetchImplementation = vi.fn();
      const client = new LLMClient({
        defaultModel: 'gpt-4o',
        fetchImplementation,
        openaiApiKey: 'openai-key',
      });

      await expect(
        client.complete({ budgetUsd: 0.000001, messages: [{ content: 'Hello', role: 'user' }] }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(fetchImplementation).not.toHaveBeenCalled();
    });
  });

  describe('Mock Client', () => {
    it('should provide deterministic queued responses through LLMClient.mock()', async () => {
      const client = LLMClient.mock({
        responses: [
          {
            content: [{ text: 'Mock queue', type: 'text' }],
            finishReason: 'stop',
            model: 'mock-model',
            provider: 'mock',
            raw: {},
            text: 'Mock queue',
            toolCalls: [],
            usage: { cachedTokens: 0, cost: '$0.00', costUSD: 0, inputTokens: 1, outputTokens: 1 },
          },
        ],
        streams: [
          [
            { delta: 'Mock stream', type: 'text-delta' },
            { finishReason: 'stop', type: 'done', usage: { cachedTokens: 0, cost: '$0.00', costUSD: 0, inputTokens: 1, outputTokens: 1 } },
          ],
        ],
      });

      const response = await client.complete({ messages: [{ content: 'Hello', role: 'user' }] });
      const chunks: StreamChunk[] = [];
      for await (const chunk of client.stream({ messages: [{ content: 'Stream', role: 'user' }] })) {
        chunks.push(chunk);
      }

      expect(response.text).toBe('Mock queue');
      expect(chunks).toEqual([
        { delta: 'Mock stream', type: 'text-delta' },
        expect.objectContaining({ finishReason: 'stop', type: 'done' }),
      ]);
    });

    it('should echo user message when no response is queued', async () => {
      const client = LLMClient.mock();
      const response = await client.complete({ messages: [{ content: 'Echo this', role: 'user' }] });
      expect(response.text).toBe('Echo this');
    });

    it('should support dynamic response functions', async () => {
      const client = LLMClient.mock({
        responses: [
          (options) => ({
            content: [{ text: `Processed: ${options.model}`, type: 'text' }],
            finishReason: 'stop',
            model: options.model,
            provider: options.provider,
            raw: {},
            text: `Processed: ${options.model}`,
            toolCalls: [],
            usage: { cachedTokens: 0, cost: '$0.00', costUSD: 0, inputTokens: 1, outputTokens: 1 },
          }),
        ],
      });

      const response = await client.complete({ messages: [{ content: 'Test', role: 'user' }] });
      expect(response.text).toBe('Processed: mock-model');
    });
  });

  describe('Conversation Management', () => {
    it('should create a new conversation when no session store is configured', async () => {
      const client = new LLMClient();
      const conversation = await client.conversation({ system: 'Fresh conversation' });
      expect(conversation.toMessages()).toEqual([{ content: 'Fresh conversation', pinned: true, role: 'system' }]);
    });

    it('should restore conversations from the session store', async () => {
      const store = new InMemorySessionStore<ConversationSnapshot>();
      await store.set(
        'manual-session',
        {
          createdAt: '2026-04-15T09:00:00.000Z',
          messages: [{ content: 'Manual record', role: 'user' }],
          model: 'gpt-4o',
          provider: 'openai',
          sessionId: 'manual-session',
          system: 'Manual system',
          totalCachedTokens: 0,
          totalCostUSD: 0.15,
          totalInputTokens: 4,
          totalOutputTokens: 2,
          updatedAt: '2026-04-15T10:00:00.000Z',
        },
        { model: 'gpt-4o', provider: 'openai' },
      );

      const client = new LLMClient({ sessionStore: store });
      const conversation = await client.conversation({ sessionId: 'manual-session' });

      expect(conversation.toMessages()).toEqual([
        { content: 'Manual system', pinned: true, role: 'system' },
        { content: 'Manual record', role: 'user' },
      ]);
    });
  });

  describe('Routing with Fallback', () => {
    it('should fall back to the next routed model after a retryable provider failure', async () => {
      const usageLogger = { log: vi.fn(async () => undefined) };
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('api.openai.com')) {
          return new Response(JSON.stringify({ error: { message: 'Temporary upstream failure' } }), {
            headers: { 'content-type': 'application/json' },
            status: 500,
          });
        }
        return new Response(
          JSON.stringify({
            content: [{ text: 'Fallback response', type: 'text' }],
            id: 'msg_1',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            stop_reason: 'end_turn',
            usage: { input_tokens: 9, output_tokens: 4 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        );
      });

      const client = new LLMClient({
        anthropicApiKey: 'anthropic-key',
        defaultModel: 'gpt-4o',
        fetchImplementation,
        modelRouter: new ModelRouter({
          rules: [{ fallback: ['claude-sonnet-4-6'], name: 'fallback-chain', target: 'gpt-4o' }],
        }),
        openaiApiKey: 'openai-key',
        retryOptions: { baseMs: 0, jitterMs: 0, maxAttempts: 1, sleep: async () => undefined },
        usageLogger,
      });

      const response = await client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
        sessionId: 'route-session',
        tenantId: 'tenant-1',
      });

      expect(response.provider).toBe('anthropic');
      expect(response.text).toBe('Fallback response');
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Usage Logging', () => {
    it('should log usage events for successful requests', async () => {
      const usageLogger = { log: vi.fn(async () => undefined) };
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
                    text: 'Logged response',
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
            usage: { input_tokens: 5, output_tokens: 3 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const client = new LLMClient({
        defaultModel: 'gpt-4o',
        fetchImplementation,
        openaiApiKey: 'openai-key',
        usageLogger,
      });

      await client.complete({
        botId: 'bot-1',
        messages: [{ content: 'Hello', role: 'user' }],
        sessionId: 'usage-session',
        tenantId: 'tenant-2',
      });

      expect(usageLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: 'bot-1',
          model: 'gpt-4o',
          provider: 'openai',
          sessionId: 'usage-session',
          tenantId: 'tenant-2',
        }),
      );
    });

    it('should swallow usage logger failures', async () => {
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
                    text: 'Still succeeds',
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
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );

      const client = new LLMClient({
        defaultModel: 'gpt-4o',
        fetchImplementation,
        openaiApiKey: 'openai-key',
        usageLogger: { log: vi.fn(async () => { throw new Error('logger failed'); }) },
      });

      await expect(
        client.complete({ messages: [{ content: 'Hello', role: 'user' }] }),
      ).resolves.toMatchObject({ text: 'Still succeeds' });
    });
  });
});

class MockPool {
  readonly options: unknown;
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  private readonly queuedRows: unknown[][] = [];

  constructor(options?: unknown) {
    this.options = options;
  }

  queueRows(rows: unknown[]): void {
    this.queuedRows.push(rows);
  }

  async end(): Promise<void> {
    return Promise.resolve();
  }

  async query(text: string, values?: unknown[]): Promise<{ rowCount: number; rows: unknown[] }> {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    this.queries.push({ text: normalizedText, ...(values ? { values } : {}) });
    if (!/^(INSERT|SELECT)\b/i.test(normalizedText) || this.queuedRows.length === 0) {
      return { rowCount: 0, rows: [] };
    }
    const rows = this.queuedRows.shift() ?? [];
    return { rowCount: rows.length, rows };
  }
}
