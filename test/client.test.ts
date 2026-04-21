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
import type { UsageSummary } from '../src/usage.js';

const createdPools = pgMockState.createdPools as MockPool[];

describe('LLMClient', () => {
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

  it('updates prices through the public client API', () => {
    const client = new LLMClient();

    client.updatePrices({
      'gpt-4o': {
        inputPrice: 3.5,
      },
    });

    expect(client.models.get('gpt-4o').inputPrice).toBe(3.5);
  });

  it('proxies model registry methods', () => {
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

  it('routes complete() calls to Anthropic by model', async () => {
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
            usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
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

  it('routes complete() calls to Gemini by model', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Gemini response' }],
                  role: 'model',
                },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: {
              candidatesTokenCount: 5,
              promptTokenCount: 10,
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
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

  it('passes OpenAI prompt caching hints through complete() routing', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      expect(body.prompt_cache_key).toBe('support-faq-v1');
      expect(body.prompt_cache_retention).toBe('24h');

      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'gpt-4o',
          object: 'response',
          output: [
            {
              content: [{ annotations: [], text: 'Cached OpenAI response', type: 'output_text' }],
              id: 'msg_1',
              role: 'assistant',
              status: 'completed',
              type: 'message',
            },
          ],
          status: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      );
    });

    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });

    const response = await client.complete({
      messages: [{ content: 'Hello', role: 'user' }],
      providerOptions: {
        openai: {
          promptCaching: {
            key: 'support-faq-v1',
            retention: '24h',
          },
        },
      },
    });

    expect(response.text).toBe('Cached OpenAI response');
  });

  it('passes Gemini cachedContent references through complete() routing', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      expect(body.cachedContent).toBe('cachedContents/support-faq-v1');

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'Cached Gemini response' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {
            candidatesTokenCount: 5,
            promptTokenCount: 10,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      );
    });

    const client = new LLMClient({
      defaultModel: 'gemini-2.5-flash',
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });

    const response = await client.complete({
      messages: [{ content: 'Hello', role: 'user' }],
      providerOptions: {
        google: {
          promptCaching: {
            cachedContent: 'cachedContents/support-faq-v1',
          },
        },
      },
    });

    expect(response.text).toBe('Cached Gemini response');
  });

  it('routes googleCaches lifecycle methods through the Gemini adapter', async () => {
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'models/gemini-2.5-flash',
            name: 'cachedContents/cache_1',
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'models/gemini-2.5-flash',
            name: 'cachedContents/cache_1',
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
      );

    const client = new LLMClient({
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });

    const created = await client.googleCaches.create({
      messages: [{ content: 'FAQ body', role: 'user' }],
      model: 'gemini-2.5-flash',
      ttl: '600s',
    });
    const fetched = await client.googleCaches.get('cache_1');
    const firstCall = fetchImplementation.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit?,
    ];
    const secondCall = fetchImplementation.mock.calls[1] as unknown as [
      RequestInfo | URL,
      RequestInit?,
    ];

    expect(created.name).toBe('cachedContents/cache_1');
    expect(fetched.name).toBe('cachedContents/cache_1');
    expect(String(firstCall[0])).toContain('/v1beta/cachedContents');
    expect(String(secondCall[0])).toContain('/v1beta/cachedContents/cache_1');
  });

  it('routes stream() calls to OpenAI by model', async () => {
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
                    usage: {
                      input_tokens: 5,
                      output_tokens: 3,
                    },
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
        {
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
        },
      ),
    );
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });

    const chunks = [];
    for await (const chunk of client.stream({
      messages: [{ content: 'Hello', role: 'user' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ delta: 'Hi', type: 'text-delta' });
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    );
  });

  it('routes stream() calls to Gemini by model', async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  candidates: [
                    {
                      content: {
                        parts: [{ text: 'Hello from Gemini' }],
                        role: 'model',
                      },
                      finishReason: 'STOP',
                      index: 0,
                    },
                  ],
                  usageMetadata: {
                    candidatesTokenCount: 3,
                    promptTokenCount: 5,
                  },
                })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        {
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
        },
      ),
    );
    const client = new LLMClient({
      defaultModel: 'gemini-2.5-flash',
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });

    const chunks = [];
    for await (const chunk of client.stream({
      messages: [{ content: 'Hello', role: 'user' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ delta: 'Hello from Gemini', type: 'text-delta' });
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    );
  });

  it('loads API keys from env via fromEnv()', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    const originalOrgId = process.env.OPENAI_ORG_ID;
    const originalProjectId = process.env.OPENAI_PROJECT_ID;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.OPENAI_ORG_ID = 'env-org';
    process.env.OPENAI_PROJECT_ID = 'env-project';
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
            usage: {
              input_tokens: 5,
              output_tokens: 3,
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
      );
      const client = LLMClient.fromEnv({
        defaultModel: 'gpt-4o',
        fetchImplementation,
      });

      const response = await client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      });
      const request = fetchImplementation.mock.calls[0] as unknown as [
        RequestInfo | URL,
        RequestInit,
      ];
      const headers = request[1].headers as Record<string, string>;

      expect(response.text).toBe('Env response');
      expect(headers.Authorization).toBe('Bearer env-openai-key');
      expect(headers['OpenAI-Organization']).toBe('env-org');
      expect(headers['OpenAI-Project']).toBe('env-project');
    } finally {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
      process.env.OPENAI_ORG_ID = originalOrgId;
      process.env.OPENAI_PROJECT_ID = originalProjectId;
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('throws on missing API keys and provider/model mismatches', async () => {
    const openaiClient = new LLMClient({
      defaultModel: 'gpt-4o',
      openaiApiKey: '',
    });
    const geminiClient = new LLMClient({
      defaultModel: 'gemini-2.5-flash',
      geminiApiKey: '',
    });
    const anthropicClient = new LLMClient({
      anthropicApiKey: '',
      defaultModel: 'claude-sonnet-4-6',
    });
    const mismatchClient = new LLMClient({
      anthropicApiKey: 'anthropic-key',
      defaultModel: 'claude-sonnet-4-6',
    });

    await expect(
      openaiClient.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    await expect(
      anthropicClient.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    await expect(
      geminiClient.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    await expect(
      mismatchClient.complete({
        messages: [{ content: 'Hello', role: 'user' }],
        provider: 'openai',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('throws if no model is configured', async () => {
    const client = new LLMClient();

    await expect(
      client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('creates a new conversation when no session store is configured', async () => {
    const client = new LLMClient();
    const conversation = await client.conversation({
      system: 'Fresh conversation',
    });

    expect(conversation.toMessages()).toEqual([
      { content: 'Fresh conversation', pinned: true, role: 'system' },
    ]);
  });

  it('restores conversations from the default DATABASE_URL-backed session store', async () => {
    process.env.DATABASE_URL = 'postgresql://example.test/default-store';

    const pool = new MockPool({ connectionString: process.env.DATABASE_URL });
    pool.queueRows([
      {
        created_at: '2026-04-15T09:00:00.000Z',
        message_count: 1,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'env-session',
        snapshot: {
          createdAt: '2026-04-15T09:00:00.000Z',
          messages: [{ content: 'Persisted hello', role: 'user' }],
          model: 'gpt-4o',
          provider: 'openai',
          sessionId: 'env-session',
          system: 'Persisted system',
          totalCachedTokens: 0,
          totalCostUSD: 0.5,
          totalInputTokens: 10,
          totalOutputTokens: 5,
          updatedAt: '2026-04-15T10:00:00.000Z',
        },
        tenant_id: '',
        total_cost_usd: 0.5,
        updated_at: '2026-04-15T10:00:00.000Z',
      },
    ]);
    pgMockState.poolConstructor.mockImplementationOnce(() => pool);

    const client = LLMClient.fromEnv();
    const conversation = await client.conversation({
      sessionId: 'env-session',
    });

    expect(conversation.toMessages()).toEqual([
      { content: 'Persisted system', pinned: true, role: 'system' },
      { content: 'Persisted hello', role: 'user' },
    ]);
    expect(pgMockState.poolConstructor).toHaveBeenCalledWith({
      connectionString: 'postgresql://example.test/default-store',
    });
  });

  it('prefers an explicit session store over the DATABASE_URL default', async () => {
    process.env.DATABASE_URL = 'postgresql://example.test/default-store';

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
      {
        model: 'gpt-4o',
        provider: 'openai',
      },
    );

    const client = new LLMClient({
      sessionStore: store,
    });
    const conversation = await client.conversation({
      sessionId: 'manual-session',
    });

    expect(conversation.toMessages()).toEqual([
      { content: 'Manual system', pinned: true, role: 'system' },
      { content: 'Manual record', role: 'user' },
    ]);
    expect(pgMockState.poolConstructor).not.toHaveBeenCalled();
  });

  it('provides deterministic queued responses through LLMClient.mock()', async () => {
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
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 1,
            outputTokens: 1,
          },
        },
      ],
      streams: [
        [
          { delta: 'Mock stream', type: 'text-delta' },
          {
            finishReason: 'stop',
            type: 'done',
            usage: {
              cachedTokens: 0,
              cost: '$0.00',
              costUSD: 0,
              inputTokens: 1,
              outputTokens: 1,
            },
          },
        ],
      ],
    });

    const response = await client.complete({
      messages: [{ content: 'Hello', role: 'user' }],
    });
    const chunks = [];
    for await (const chunk of client.stream({
      messages: [{ content: 'Stream', role: 'user' }],
    })) {
      chunks.push(chunk);
    }

    expect(response.text).toBe('Mock queue');
    expect(chunks).toEqual([
      { delta: 'Mock stream', type: 'text-delta' },
      expect.objectContaining({ finishReason: 'stop', type: 'done' }),
    ]);
  });

  it('throws for unimplemented providers in complete() and stream()', async () => {
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
      client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'mock-llm',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      (async () => {
        for await (const chunk of client.stream({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'mock-llm',
        })) {
          void chunk;
        }
      })(),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('falls back to the next routed model after a retryable provider failure', async () => {
    const usageLogger = {
      log: vi.fn(async () => undefined),
    };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Temporary upstream failure',
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 500,
          },
        );
      }

      return new Response(
        JSON.stringify({
          content: [{ text: 'Fallback response', type: 'text' }],
          id: 'msg_1',
          model: 'claude-sonnet-4-6',
          role: 'assistant',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 9,
            output_tokens: 4,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      );
    });
    const client = new LLMClient({
      anthropicApiKey: 'anthropic-key',
      defaultModel: 'gpt-4o',
      fetchImplementation,
      modelRouter: new ModelRouter({
        rules: [
          {
            fallback: ['claude-sonnet-4-6'],
            name: 'fallback-chain',
            target: 'gpt-4o',
          },
        ],
      }),
      openaiApiKey: 'openai-key',
      retryOptions: {
        baseMs: 0,
        jitterMs: 0,
        maxAttempts: 1,
        sleep: async () => undefined,
      },
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
    expect(usageLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        routingDecision:
          'rule:fallback-chain:primary:gpt-4o -> rule:fallback-chain:fallback:1:claude-sonnet-4-6',
        sessionId: 'route-session',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('falls back during streaming before any chunks are emitted', async () => {
    const usageLogger = {
      log: vi.fn(async () => undefined),
    };
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; stream?: boolean };
      if (body.model === 'gpt-4o') {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Temporary upstream failure',
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 500,
          },
        );
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  content_index: 0,
                  delta: 'Fallback stream',
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
                    model: 'gpt-4o-mini',
                    object: 'response',
                    output: [
                      {
                        content: [
                          {
                            annotations: [],
                            text: 'Fallback stream',
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
                      input_tokens: 4,
                      output_tokens: 2,
                    },
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
        {
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
        },
      );
    });
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      modelRouter: new ModelRouter({
        rules: [
          {
            fallback: ['gpt-4o-mini'],
            name: 'stream-fallback',
            target: 'gpt-4o',
          },
        ],
      }),
      openaiApiKey: 'openai-key',
      retryOptions: {
        baseMs: 0,
        jitterMs: 0,
        maxAttempts: 1,
        sleep: async () => undefined,
      },
      usageLogger,
    });

    const chunks = [];
    for await (const chunk of client.stream({
      messages: [{ content: 'Hello', role: 'user' }],
      sessionId: 'stream-session',
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ delta: 'Fallback stream', type: 'text-delta' });
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(usageLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        routingDecision: 'rule:stream-fallback:primary:gpt-4o -> rule:stream-fallback:fallback:1:gpt-4o-mini',
        sessionId: 'stream-session',
      }),
    );
  });

  it('does not fall back after streaming has already emitted output', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      if (body.model === 'gpt-4o') {
        return new Response(
          new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  content_index: 0,
                  delta: 'partial',
                  item_id: 'msg_1',
                  output_index: 0,
                  sequence_number: 1,
                  type: 'response.output_text.delta',
                })}\n\n`,
              ),
            );
          },
            pull(controller) {
              controller.error(new Error('stream exploded'));
            },
          }),
          {
            headers: { 'content-type': 'text/event-stream' },
            status: 200,
          },
        );
      }

      return new Response('unexpected fallback', { status: 500 });
    });
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      modelRouter: new ModelRouter({
        rules: [
          {
            fallback: ['gpt-4o-mini'],
            name: 'stream-no-fallback-after-output',
            target: 'gpt-4o',
          },
        ],
      }),
      openaiApiKey: 'openai-key',
      retryOptions: {
        baseMs: 0,
        jitterMs: 0,
        maxAttempts: 1,
        sleep: async () => undefined,
      },
    });

    const chunks: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.stream({
          messages: [{ content: 'Hello', role: 'user' }],
        })) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toThrow('stream exploded');
    expect(chunks).toContainEqual({ delta: 'partial', type: 'text-delta' });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('logs usage events for successful requests', async () => {
    const usageLogger = {
      log: vi.fn(async () => undefined),
    };
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
          usage: {
            input_tokens: 5,
            output_tokens: 3,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
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
        routingDecision: 'default:gpt-4o',
        sessionId: 'usage-session',
        tenantId: 'tenant-2',
      }),
    );
  });

  it('swallows usage logger failures', async () => {
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
          usage: {
            input_tokens: 5,
            output_tokens: 2,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      ),
    );
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
      usageLogger: {
        log: vi.fn(async () => {
          throw new Error('logger failed');
        }),
      },
    });

    await expect(
      client.complete({
        messages: [{ content: 'Hello', role: 'user' }],
      }),
    ).resolves.toMatchObject({
      text: 'Still succeeds',
    });
  });

  it('enforces per-call budget guards before dispatching requests', async () => {
    const fetchImplementation = vi.fn();
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });

    await expect(
      client.complete({
        budgetUsd: 0.000001,
        messages: [{ content: 'Hello', role: 'user' }],
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('can warn and continue when a request exceeds the per-call budget', async () => {
    const onWarning = vi.fn();
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
                  text: 'Allowed with warning',
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
            input_tokens: 5,
            output_tokens: 2,
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      ),
    );
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      onWarning,
      openaiApiKey: 'openai-key',
    });

    await expect(
      client.complete({
        budgetExceededAction: 'warn',
        budgetUsd: 0.000001,
        messages: [{ content: 'Hello', role: 'user' }],
      }),
    ).resolves.toMatchObject({
      text: 'Allowed with warning',
    });
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Estimated request cost'),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('can skip provider dispatch when a request exceeds the per-call budget', async () => {
    const fetchImplementation = vi.fn();
    const usageLogger = {
      log: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
      usageLogger,
    });

    const response = await client.complete({
      budgetExceededAction: 'skip',
      budgetUsd: 0.000001,
      messages: [{ content: 'Hello', role: 'user' }],
      sessionId: 'skipped-session',
    });

    expect(response.finishReason).toBe('error');
    expect(response.text).toContain('Estimated request cost');
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(usageLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        finishReason: 'error',
        sessionId: 'skipped-session',
      }),
    );
  });

  it('exposes a cancel() contract for streaming requests', async () => {
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw init.signal.reason ?? new Error('aborted');
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start() {},
        }),
        {
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
        },
      );
    });
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });

    const stream = client.stream({
      messages: [{ content: 'Cancel me', role: 'user' }],
    });

    stream.cancel(new Error('manual cancel'));

    expect(stream.signal.aborted).toBe(true);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('delegates getUsage() to the configured usage logger', async () => {
    const summary: UsageSummary = {
      breakdown: [
        {
          model: 'gpt-4o',
          provider: 'openai',
          requestCount: 2,
          totalCachedTokens: 4,
          totalCostUSD: 0.03,
          totalInputTokens: 20,
          totalOutputTokens: 8,
        },
      ],
      requestCount: 2,
      totalCachedTokens: 4,
      totalCostUSD: 0.03,
      totalInputTokens: 20,
      totalOutputTokens: 8,
    };
    const usageLogger = {
      getUsage: vi.fn(async () => summary),
      log: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      usageLogger,
    });

    await expect(client.getUsage({ tenantId: 'tenant-1' })).resolves.toEqual(summary);
    expect(usageLogger.getUsage).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
  });

  it('throws from getUsage() when aggregation is not configured', async () => {
    const client = new LLMClient();

    await expect(client.getUsage()).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('exports aggregated usage as CSV through the client surface', async () => {
    const usageLogger = {
      getUsage: vi.fn(async () => ({
        breakdown: [
          {
            model: 'gpt-4o',
            provider: 'openai' as const,
            requestCount: 1,
            totalCachedTokens: 0,
            totalCostUSD: 0.01,
            totalInputTokens: 10,
            totalOutputTokens: 4,
          },
        ],
        requestCount: 1,
        totalCachedTokens: 0,
        totalCostUSD: 0.01,
        totalInputTokens: 10,
        totalOutputTokens: 4,
      })),
      log: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      usageLogger,
    });

    await expect(client.exportUsage('csv')).resolves.toContain(
      'provider,model,requestCount,totalInputTokens,totalOutputTokens,totalCachedTokens,totalCostUSD',
    );
  });

  it('OpenAI conversation loop: store:false, no previous_response_id, full history re-sent every turn', async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      const turnIndex = capturedBodies.length;

      return new Response(
        JSON.stringify({
          id: `resp_${turnIndex}`,
          model: 'gpt-4o',
          object: 'response',
          output: [
            {
              content: [
                {
                  annotations: [],
                  text: turnIndex === 1 ? 'First reply' : 'Second reply',
                  type: 'output_text',
                },
              ],
              id: `msg_${turnIndex}`,
              role: 'assistant',
              status: 'completed',
              type: 'message',
            },
          ],
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      );
    });

    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });

    const conversation = await client.conversation({ system: 'Be concise.' });
    await conversation.send('Turn one');
    await conversation.send('Turn two');

    expect(capturedBodies).toHaveLength(2);

    for (const body of capturedBodies) {
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty('previous_response_id');
      expect(body).not.toHaveProperty('conversation');
    }

    const firstInput = capturedBodies[0]?.input as unknown[];
    const secondInput = capturedBodies[1]?.input as unknown[];

    expect(firstInput).toHaveLength(1);

    expect(secondInput.length).toBeGreaterThan(firstInput.length);

    const firstInputMessages = firstInput.filter(
      (item) => (item as { role?: string }).role === 'user',
    );
    const secondInputMessages = secondInput.filter(
      (item) => (item as { role?: string }).role === 'user',
    );
    expect(secondInputMessages.length).toBeGreaterThan(firstInputMessages.length);
  });

  it('keeps model registry state isolated across client instances', () => {
    const first = new LLMClient();
    const second = new LLMClient();

    first.updatePrices({
      'gpt-4o': {
        inputPrice: 99,
      },
    });

    expect(first.models.get('gpt-4o').inputPrice).toBe(99);
    expect(second.models.get('gpt-4o').inputPrice).not.toBe(99);
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
      return {
        rowCount: 0,
        rows: [],
      };
    }

    const rows = this.queuedRows.shift() ?? [];
    return {
      rowCount: rows.length,
      rows,
    };
  }
}
