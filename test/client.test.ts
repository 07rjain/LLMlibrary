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
  MockQueueExhaustedError,
  ProviderCapabilityError,
  ProviderError,
} from '../src/errors.js';
import { LLMClient } from '../src/client.js';
import { ModelRegistry } from '../src/models/registry.js';
import { ModelRouter } from '../src/router.js';
import { InMemorySessionStore } from '../src/session-store.js';

import type { ConversationSnapshot } from '../src/conversation.js';
import type { StreamChunk } from '../src/types.js';
import type {
  SpeechUsageEvent,
  SpeechUsageSummary,
  UsageSummary,
} from '../src/usage.js';

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

  it('quotes completion cost without sending a request', () => {
    const client = new LLMClient({ defaultModel: 'gpt-4o' });
    const estimate = client.estimateRequest({
      maxTokens: 100,
      messages: [{ content: 'Hello', role: 'user' }],
    });

    expect(estimate.model).toBe('gpt-4o');
    expect(estimate.provider).toBe('openai');
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.maxOutputTokens).toBe(100);
    expect(estimate.priceVersion).toBe(client.models.get('gpt-4o').lastUpdated);
    expect(estimate.estimatedCostUSD).toBeGreaterThan(0);
  });

  it('quotes the primary model selected by ModelRouter', () => {
    const client = new LLMClient({
      modelRouter: new ModelRouter({
        rules: [
          {
            fallback: ['claude-haiku-4-5'],
            name: 'quote-route',
            target: 'gpt-4o-mini',
          },
        ],
      }),
    });

    const estimate = client.estimateRequest({
      maxTokens: 64,
      messages: [{ content: 'Hello', role: 'user' }],
    });

    expect(estimate.model).toBe('gpt-4o-mini');
    expect(estimate.provider).toBe('openai');
    expect(estimate.maxOutputTokens).toBe(64);
    expect(estimate.estimatedCostUSD).toBeGreaterThan(0);
  });

  it('proxies model registry methods', () => {
    const client = new LLMClient();
    client.models.register({
      contextWindow: 64000,
      id: 'custom-model',
      inputPrice: 1,
      kind: 'completion',
      lastUpdated: '2026-04-15',
      outputPrice: 2,
      provider: 'mock',
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false,
    });

    expect(client.models.get('custom-model').provider).toBe('mock');
    expect(
      client.models.list().some((model) => model.id === 'custom-model'),
    ).toBe(true);
  });

  it('lists remote OpenAI models through the public client API', async () => {
    const created = 1_710_000_000;
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                created,
                id: 'gpt-5.4',
                object: 'model',
                owned_by: 'system',
              },
            ],
            object: 'list',
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
    );

    const client = new LLMClient({
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });

    const models = await client.models.listRemote({ provider: 'openai' });
    const request = fetchImplementation.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = request[1].headers as Record<string, string>;

    expect(String(request[0])).toBe('https://api.openai.com/v1/models');
    expect(headers.Authorization).toBe('Bearer openai-key');
    expect(models).toEqual([
      {
        createdAt: new Date(created * 1000).toISOString(),
        displayName: 'gpt-5.4',
        id: 'gpt-5.4',
        ownedBy: 'system',
        provider: 'openai',
        raw: {
          created,
          id: 'gpt-5.4',
          object: 'model',
          owned_by: 'system',
        },
      },
    ]);
  });

  it('paginates Anthropic remote model discovery', async () => {
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                created_at: '2026-04-14T00:00:00Z',
                display_name: 'Claude Opus 4.7',
                id: 'claude-opus-4-7',
                type: 'model',
              },
            ],
            has_more: true,
            last_id: 'claude-opus-4-7',
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
            data: [
              {
                created_at: '2026-02-17T00:00:00Z',
                display_name: 'Claude Sonnet 4.6',
                id: 'claude-sonnet-4-6',
                type: 'model',
              },
            ],
            has_more: false,
            last_id: 'claude-sonnet-4-6',
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
      );

    const client = new LLMClient({
      anthropicApiKey: 'anthropic-key',
      fetchImplementation,
    });

    const models = await client.models.listRemote({ provider: 'anthropic' });
    const firstRequest = fetchImplementation.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    const secondRequest = fetchImplementation.mock.calls[1] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = firstRequest[1].headers as Record<string, string>;

    expect(String(firstRequest[0])).toBe(
      'https://api.anthropic.com/v1/models?limit=100',
    );
    expect(String(secondRequest[0])).toContain('after_id=claude-opus-4-7');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe('anthropic-key');
    expect(models).toMatchObject([
      {
        createdAt: '2026-04-14T00:00:00Z',
        displayName: 'Claude Opus 4.7',
        id: 'claude-opus-4-7',
        provider: 'anthropic',
      },
      {
        createdAt: '2026-02-17T00:00:00Z',
        displayName: 'Claude Sonnet 4.6',
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
      },
    ]);
  });

  it('paginates Gemini remote model discovery and normalizes ids', async () => {
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                displayName: 'Gemini 2.5 Flash',
                inputTokenLimit: 1_048_576,
                name: 'models/gemini-2.5-flash',
                outputTokenLimit: 65_536,
                supportedGenerationMethods: [
                  'generateContent',
                  'createCachedContent',
                ],
              },
            ],
            nextPageToken: 'page-2',
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
            models: [
              {
                displayName: 'Gemini Embedding 001',
                inputTokenLimit: 2_048,
                name: 'models/gemini-embedding-001',
                outputTokenLimit: 1,
                supportedGenerationMethods: ['embedContent'],
              },
            ],
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

    const models = await client.models.listRemote({ provider: 'google' });
    const firstRequest = fetchImplementation.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    const secondRequest = fetchImplementation.mock.calls[1] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = firstRequest[1].headers as Record<string, string>;

    expect(String(firstRequest[0])).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
    );
    expect(String(secondRequest[0])).toContain('pageToken=page-2');
    expect(headers['x-goog-api-key']).toBe('gemini-key');
    expect(models).toMatchObject([
      {
        displayName: 'Gemini 2.5 Flash',
        id: 'gemini-2.5-flash',
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        provider: 'google',
        providerId: 'models/gemini-2.5-flash',
        supportedActions: ['generateContent', 'createCachedContent'],
      },
      {
        displayName: 'Gemini Embedding 001',
        id: 'gemini-embedding-001',
        provider: 'google',
        providerId: 'models/gemini-embedding-001',
        supportedActions: ['embedContent'],
      },
    ]);
  });

  it('skips malformed remote model rows while preserving valid row order', async () => {
    const cases = [
      {
        options: { openaiApiKey: 'key' },
        payload: {
          data: [
            { created: 1, id: 'first-openai' },
            {},
            { id: 'second-openai' },
          ],
        },
        provider: 'openai' as const,
      },
      {
        options: { anthropicApiKey: 'key' },
        payload: {
          data: [{ id: 'first-anthropic' }, null, { id: 'second-anthropic' }],
          has_more: false,
        },
        provider: 'anthropic' as const,
      },
      {
        options: { geminiApiKey: 'key' },
        payload: {
          models: [
            { name: 'models/first-google' },
            {},
            { name: 'models/second-google' },
          ],
        },
        provider: 'google' as const,
      },
    ];

    for (const testCase of cases) {
      const fetchImplementation = vi.fn(
        async () =>
          new Response(JSON.stringify(testCase.payload), { status: 200 }),
      );
      const client = new LLMClient({
        ...testCase.options,
        fetchImplementation,
      });

      await expect(
        client.models.listRemote({ provider: testCase.provider }),
      ).resolves.toMatchObject([
        { id: `first-${testCase.provider}`, provider: testCase.provider },
        { id: `second-${testCase.provider}`, provider: testCase.provider },
      ]);
    }
  });

  it('surfaces invalid discovery JSON and envelopes as sanitized 502 errors', async () => {
    const cases = [
      { options: { openaiApiKey: 'key' }, provider: 'openai' as const },
      { options: { anthropicApiKey: 'key' }, provider: 'anthropic' as const },
      { options: { geminiApiKey: 'key' }, provider: 'google' as const },
    ];

    for (const testCase of cases) {
      for (const body of ['{', JSON.stringify({ unexpected: [] })]) {
        const client = new LLMClient({
          ...testCase.options,
          fetchImplementation: vi.fn(
            async () => new Response(body, { status: 200 }),
          ),
        });
        const error = await client.models
          .listRemote({ provider: testCase.provider })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({
          provider: testCase.provider,
          retryable: false,
          statusCode: 502,
        });
        expect((error as ProviderError).details).toEqual({
          constraint: expect.any(String),
          option: expect.any(String),
        });
      }
    }
  });

  it('rejects missing and repeated discovery cursors without looping', async () => {
    const missingAnthropicCursor = new LLMClient({
      anthropicApiKey: 'key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ id: 'one' }], has_more: true }),
          ),
      ),
    });
    await expect(
      missingAnthropicCursor.models.listRemote({ provider: 'anthropic' }),
    ).rejects.toMatchObject({
      details: { constraint: 'non_empty_string', option: 'last_id' },
      statusCode: 502,
    });

    const invalidAnthropicState = new LLMClient({
      anthropicApiKey: 'key',
      fetchImplementation: vi.fn(
        async () => new Response(JSON.stringify({ data: [] })),
      ),
    });
    await expect(
      invalidAnthropicState.models.listRemote({ provider: 'anthropic' }),
    ).rejects.toMatchObject({
      details: { constraint: 'boolean', option: 'has_more' },
      statusCode: 502,
    });

    const invalidGoogleCursor = new LLMClient({
      fetchImplementation: vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [], nextPageToken: 123 })),
      ),
      geminiApiKey: 'key',
    });
    await expect(
      invalidGoogleCursor.models.listRemote({ provider: 'google' }),
    ).rejects.toMatchObject({
      details: { constraint: 'non_empty_string', option: 'nextPageToken' },
      statusCode: 502,
    });

    for (const testCase of [
      {
        options: { anthropicApiKey: 'key' },
        page: { data: [], has_more: true, last_id: 'repeat' },
        provider: 'anthropic' as const,
      },
      {
        options: { geminiApiKey: 'key' },
        page: { models: [], nextPageToken: 'repeat' },
        provider: 'google' as const,
      },
    ]) {
      const fetchImplementation = vi.fn(
        async () =>
          new Response(JSON.stringify(testCase.page), { status: 200 }),
      );
      const client = new LLMClient({
        ...testCase.options,
        fetchImplementation,
      });

      await expect(
        client.models.listRemote({ provider: testCase.provider }),
      ).rejects.toMatchObject({
        details: { constraint: 'unique_pagination_cursor' },
        statusCode: 502,
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    }
  });

  it('throws when remote model discovery is requested without provider credentials', async () => {
    const client = new LLMClient();

    await expect(
      client.models.listRemote({ provider: 'openai' }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('routes embed() calls to Gemini using the default embedding model', async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;

        expect(body).toMatchObject({
          outputDimensionality: 768,
          taskType: 'RETRIEVAL_QUERY',
        });

        return new Response(
          JSON.stringify({
            embedding: {
              values: [0.11, 0.22, 0.33],
            },
            usageMetadata: {
              promptTokenCount: 12,
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        );
      },
    );

    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });

    const response = await client.embed({
      dimensions: 768,
      input: 'Where is my refund?',
      purpose: 'retrieval_query',
    });

    const request = fetchImplementation.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];

    expect(String(request[0])).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent',
    );
    expect(response.provider).toBe('google');
    expect(response.embeddings[0]?.values).toEqual([0.11, 0.22, 0.33]);
    expect(response.usage).toMatchObject({
      inputTokens: 12,
    });
  });

  it('pre-aborts embeddings without fetching or consuming a mock queue entry', async () => {
    const controller = new AbortController();
    const abortReason = new Error('embedding canceled before dispatch');
    controller.abort(abortReason);
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        input: 'do not fetch',
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(fetchImplementation).not.toHaveBeenCalled();

    const queued = {
      embeddings: [{ index: 0, values: [0.1, 0.2] }],
      model: 'mock-embedding-model',
      provider: 'mock' as const,
      raw: { queued: true },
    };
    const mock = LLMClient.mock({ embeddings: [queued] });
    await expect(
      mock.embed({
        input: 'do not consume',
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    await expect(mock.embed({ input: 'consume now' })).resolves.toBe(queued);
  });

  it('rejects unsupported embedding providers in v1', async () => {
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        input: 'Hello',
        provider: 'openai' as never,
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('rejects completion models in embed()', async () => {
    const client = new LLMClient({
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        input: 'Hello',
        model: 'gemini-2.5-flash',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('rejects unsupported embedding dimensions', async () => {
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        dimensions: 4096,
        input: 'Hello',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('rejects embedding titles outside retrieval_document requests', async () => {
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        input: 'Hello',
        providerOptions: {
          google: {
            title: 'Refund Policy',
          },
        },
        purpose: 'retrieval_query',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('rejects multi-file embedding inputs in a single item', async () => {
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        input: [
          [
            {
              data: 'cGRm',
              mediaType: 'application/pdf',
              type: 'document',
            },
            {
              mediaType: 'audio/wav',
              type: 'audio',
              url: 'https://example.test/audio.wav',
            },
          ],
        ],
        purpose: 'retrieval_document',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('rejects multiple files of the same modality in one embedding item', async () => {
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        input: [
          [
            {
              data: 'cGRm',
              mediaType: 'application/pdf',
              type: 'document',
            },
            {
              data: 'cGRmMg==',
              mediaType: 'application/pdf',
              type: 'document',
            },
          ],
        ],
        purpose: 'retrieval_document',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('rejects empty embedding text and tool parts before dispatch', async () => {
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.embed({
        input: '   ',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      client.embed({
        input: [],
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      client.embed({
        input: [
          {
            args: {},
            id: 'call_1',
            name: 'lookup',
            type: 'tool_call',
          },
        ] as never,
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it.each([
    ['empty string', ''],
    ['whitespace string', '   '],
    ['empty array', []],
    ['null input', null],
    ['undefined input', undefined],
    ['mixed empty batch', ['valid', '']],
    ['mixed null batch', ['valid', null]],
    ['malformed part', [{ text: 'missing type' }]],
    ['null part', [{ text: 'valid', type: 'text' }, null]],
    ['empty text part', [{ text: ' ', type: 'text' }]],
  ])('rejects invalid embedding input: %s', async (_label, input) => {
    const fetchImplementation = vi.fn();
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });

    await expect(client.embed({ input } as never)).rejects.toMatchObject({
      details: {
        option: 'input',
      },
      name: 'ProviderCapabilityError',
      statusCode: 400,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('accepts every public embedding purpose and preserves valid batch indexes', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            embedding: {
              values: [bodies.length],
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        );
      },
    );
    const client = new LLMClient({
      defaultEmbeddingModel: 'gemini-embedding-2',
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });
    const purposes = [
      ['retrieval_document', 'RETRIEVAL_DOCUMENT'],
      ['retrieval_query', 'RETRIEVAL_QUERY'],
      ['semantic_similarity', 'SEMANTIC_SIMILARITY'],
      ['classification', 'CLASSIFICATION'],
      ['clustering', 'CLUSTERING'],
    ] as const;

    for (const [purpose, taskType] of purposes) {
      await client.embed({ input: 'valid', purpose });
      expect(bodies.at(-1)?.taskType).toBe(taskType);
    }

    const batch = await client.embed({ input: ['first', 'second'] });
    expect(batch.embeddings).toEqual([
      { index: 0, values: [6] },
      { index: 1, values: [7] },
    ]);
  });

  it.each([['unknown'], [null], [{ unexpected: true }]])(
    'rejects invalid embedding purpose %# before dispatch',
    async (purpose) => {
      const fetchImplementation = vi.fn();
      const client = new LLMClient({
        defaultEmbeddingModel: 'gemini-embedding-2',
        fetchImplementation,
        geminiApiKey: 'gemini-key',
      });

      await expect(
        client.embed({
          input: 'valid',
          purpose,
        } as never),
      ).rejects.toMatchObject({
        details: {
          constraint: 'supported_embedding_purpose',
          option: 'purpose',
        },
        name: 'ProviderCapabilityError',
        statusCode: 400,
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([127, 3073, 0, -1, 1.5, Number.NaN, Infinity, -Infinity])(
    'rejects invalid embedding dimensions %s before dispatch',
    async (dimensions) => {
      const fetchImplementation = vi.fn();
      const client = new LLMClient({
        defaultEmbeddingModel: 'gemini-embedding-2',
        fetchImplementation,
        geminiApiKey: 'gemini-key',
      });

      await expect(
        client.embed({ dimensions, input: 'valid' }),
      ).rejects.toMatchObject({
        details: {
          option: 'dimensions',
        },
        name: 'ProviderCapabilityError',
        statusCode: 400,
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([128, 512, 768, 1024, 1536, 3072])(
    'accepts supported embedding dimensions %s',
    async (dimensions) => {
      const fetchImplementation = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ embedding: { values: [dimensions] } }),
            {
              headers: { 'content-type': 'application/json' },
              status: 200,
            },
          ),
      );
      const client = new LLMClient({
        defaultEmbeddingModel: 'gemini-embedding-2',
        fetchImplementation,
        geminiApiKey: 'gemini-key',
      });

      const response = await client.embed({ dimensions, input: 'valid' });

      expect(response.embeddings[0]?.values).toEqual([dimensions]);
      expect(fetchImplementation).toHaveBeenCalledOnce();
    },
  );

  it('honors custom embedding bounds and allows metadata-absent dimensions', async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: { values: [1] } }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    );
    const client = new LLMClient({
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });
    const baseModel = {
      contextWindow: 8192,
      inputPrice: 0,
      kind: 'embedding' as const,
      lastUpdated: '2026-07-29',
      outputPrice: 0,
      provider: 'google' as const,
      supportedInputModalities: ['text'] as const,
      supportsStreaming: false,
      supportsTools: false,
      supportsVision: false,
    };
    client.models.register({
      ...baseModel,
      embeddingDimensions: { default: 3, max: 4, min: 2 },
      id: 'custom-bounded-embedding',
      supportedInputModalities: ['text'],
    });
    client.models.register({
      ...baseModel,
      id: 'custom-unbounded-embedding',
      supportedInputModalities: ['text'],
    });

    await expect(
      client.embed({
        dimensions: 1,
        input: 'valid',
        model: 'custom-bounded-embedding',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.embed({
        dimensions: 5,
        input: 'valid',
        model: 'custom-bounded-embedding',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.embed({
        dimensions: 1,
        input: 'valid',
        model: 'custom-unbounded-embedding',
      }),
    ).resolves.toMatchObject({
      embeddings: [{ index: 0, values: [1] }],
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('provides deterministic queued embeddings through LLMClient.mock()', async () => {
    const client = LLMClient.mock({
      defaultEmbeddingModel: 'gemini-embedding-2',
      embeddings: [
        {
          embeddings: [{ index: 0, values: [0.5, 0.6] }],
          model: 'gemini-embedding-2',
          provider: 'mock',
          raw: { mock: true },
        },
      ],
    });

    const response = await client.embed({
      input: 'Hello',
    });

    expect(response.embeddings[0]?.values).toEqual([0.5, 0.6]);
    expect(response.provider).toBe('mock');
  });

  it('validates mock embeddings without consuming the queued response', async () => {
    const client = LLMClient.mock({
      defaultEmbeddingModel: 'gemini-embedding-2',
      embeddings: [
        {
          embeddings: [{ index: 0, values: [0.9] }],
          model: 'gemini-embedding-2',
          provider: 'mock',
          raw: { queued: true },
        },
      ],
    });

    await expect(client.embed({ input: '' })).rejects.toBeInstanceOf(
      ProviderCapabilityError,
    );
    await expect(
      client.embed({ input: 'valid', purpose: 'unknown' as never }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.embed({ dimensions: 0, input: 'valid' }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    const response = await client.embed({
      dimensions: 3,
      input: 'valid',
    });
    expect(response.embeddings[0]?.values).toEqual([0.9]);
    expect(response.raw).toEqual({ queued: true });
  });

  it('provides deterministic queued speech responses through LLMClient.mock()', async () => {
    const client = LLMClient.mock({
      speeches: [
        {
          audio: new Uint8Array([7, 8, 9]),
          format: 'mp3',
          mediaType: 'audio/mpeg',
          model: 'mock-speech-model',
          provider: 'mock',
          raw: { mock: true },
          usage: {
            cost: '$0.00',
            costUSD: 0,
            inputCharacters: 5,
            inputTokens: 2,
          },
        },
      ],
      transcriptions: [
        {
          model: 'mock-transcription-model',
          provider: 'mock',
          raw: { mock: true },
          text: 'mock transcript',
          usage: {
            cost: '$0.00',
            costUSD: 0,
            inputAudioSeconds: 1.5,
          },
        },
      ],
    });

    const speech = await client.speak({ input: 'Hello' });
    const transcription = await client.transcribe({
      input: {
        file: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/wav',
      },
    });

    expect([...speech.audio]).toEqual([7, 8, 9]);
    expect(speech.provider).toBe('mock');
    expect(transcription.text).toBe('mock transcript');
    expect(transcription.provider).toBe('mock');
  });

  it('routes OpenAI speech calls, logs speech usage, and preserves metadata', async () => {
    const usageLogger = {
      log: vi.fn(async () => undefined),
      logSpeech: vi.fn(async () => undefined),
    };
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'audio/mpeg' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'speech transcript' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    const client = new LLMClient({
      fetchImplementation,
      openaiApiKey: 'openai-key',
      usageLogger,
    });

    const speech = await client.speak({
      botId: 'bot-1',
      estimatedOutputSeconds: 2,
      input: 'Speak this',
      model: 'gpt-4o-mini-tts',
      sessionId: 'speech-session',
      tenantId: 'tenant-1',
    });
    const transcript = await client.transcribe({
      botId: 'bot-1',
      input: {
        file: new Uint8Array([1, 2, 3]),
        mediaType: 'audio/mpeg',
      },
      inputAudioSeconds: 2,
      model: 'gpt-4o-mini-transcribe',
      sessionId: 'speech-session',
      tenantId: 'tenant-1',
    });

    expect([...speech.audio]).toEqual([1, 2, 3, 4]);
    expect(transcript.text).toBe('speech transcript');
    expect(usageLogger.logSpeech).toHaveBeenCalledTimes(2);
    expect(usageLogger.logSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        kind: 'speech',
        model: 'gpt-4o-mini-tts',
        provider: 'openai',
        sessionId: 'speech-session',
        tenantId: 'tenant-1',
      }),
    );
    expect(usageLogger.logSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'transcription',
        model: 'gpt-4o-mini-transcribe',
      }),
    );
  });

  it('handles speech validation, unsupported providers, and budget preflight', async () => {
    const fetchImplementation = vi.fn();
    const onWarning = vi.fn();
    const usageLogger = {
      log: vi.fn(async () => undefined),
      logSpeech: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      fetchImplementation,
      onWarning,
      openaiApiKey: 'openai-key',
      usageLogger,
    });

    await expect(client.speak({ input: '' })).rejects.toBeInstanceOf(
      ProviderCapabilityError,
    );
    await expect(
      client.speak({
        input: 'Hello',
        model: 'gpt-4o-mini-tts',
        provider: 'google',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.transcribe({
        input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
        model: 'gpt-4o-mini-transcribe',
        provider: 'google',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.speak({
        budgetUsd: 1,
        input: 'Hello',
        model: 'gpt-4o-mini-tts',
      }),
    ).rejects.toThrow('estimatedOutputSeconds or maxOutputSeconds');
    await expect(
      client.transcribe({
        budgetUsd: 1,
        input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
        model: 'gpt-4o-mini-transcribe',
      }),
    ).rejects.toThrow('inputAudioSeconds');
    await expect(
      client.speak({
        budgetUsd: 0.000001,
        estimatedOutputSeconds: 10,
        input: 'Hello',
        model: 'gpt-4o-mini-tts',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    const speechGetter = vi.fn(() => 'secret speech');
    const speechAccessor = Object.defineProperty({}, 'input', {
      enumerable: true,
      get: speechGetter,
    });
    const transcriptionGetter = vi.fn(() => ({
      file: new Uint8Array([1]),
      mediaType: 'audio/mpeg',
    }));
    const transcriptionAccessor = Object.defineProperty({}, 'input', {
      enumerable: true,
      get: transcriptionGetter,
    });
    await expect(client.speak(speechAccessor as never)).rejects.toBeInstanceOf(
      ProviderCapabilityError,
    );
    await expect(
      client.speak({ input: 'Hello', unknown: true } as never),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.transcribe(transcriptionAccessor as never),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.transcribe({
        input: {
          file: new Uint8Array([1]),
          mediaType: 'audio/mpeg',
        },
        unknown: true,
      } as never),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(speechGetter).not.toHaveBeenCalled();
    expect(transcriptionGetter).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
    expect(usageLogger.log).not.toHaveBeenCalled();
    expect(usageLogger.logSpeech).not.toHaveBeenCalled();

    const warnFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
        }),
    );
    const warnClient = new LLMClient({
      fetchImplementation: warnFetch,
      onWarning,
      openaiApiKey: 'openai-key',
    });
    await expect(
      warnClient.speak({
        budgetExceededAction: 'warn',
        budgetUsd: 0.000001,
        estimatedOutputSeconds: 10,
        input: 'Hello',
        model: 'gpt-4o-mini-tts',
      }),
    ).resolves.toMatchObject({ provider: 'openai' });
    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining('Estimated speech request cost'),
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('applies speech budget actions before real dispatch with separate usage logs', async () => {
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ duration: 2, text: 'done' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    const onWarning = vi.fn();
    const usageLogger = {
      log: vi.fn(async () => undefined),
      logSpeech: vi.fn(async (_event: SpeechUsageEvent) => undefined),
    };
    const client = new LLMClient({
      fetchImplementation,
      onWarning,
      openaiApiKey: 'openai-key',
      usageLogger,
    });

    await expect(
      client.speak({
        budgetExceededAction: 'throw',
        budgetUsd: 0,
        estimatedOutputSeconds: 2,
        input: 'throw',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(usageLogger.logSpeech).not.toHaveBeenCalled();

    const skippedSpeech = await client.speak({
      budgetExceededAction: 'skip',
      budgetUsd: 0,
      estimatedOutputSeconds: 2,
      format: 'wav',
      input: 'skip',
    });
    expect(skippedSpeech).toMatchObject({
      format: 'wav',
      mediaType: 'audio/wav',
      model: 'gpt-4o-mini-tts',
      provider: 'openai',
      raw: { reason: 'budget_exceeded', skipped: true },
      usage: {
        cost: '$0.00',
        costUSD: 0,
        estimated: true,
        outputAudioSeconds: 2,
      },
    });
    expect([...skippedSpeech.audio]).toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();

    const skippedTranscription = await client.transcribe({
      budgetExceededAction: 'skip',
      budgetUsd: 0,
      input: { file: makeWavBytes({ seconds: 2 }), mediaType: 'audio/wav' },
    });
    expect(skippedTranscription).toMatchObject({
      durationSeconds: 2,
      model: 'gpt-4o-mini-transcribe',
      provider: 'openai',
      raw: { reason: 'budget_exceeded', skipped: true },
      text: '',
      usage: {
        cost: '$0.00',
        costUSD: 0,
        estimated: true,
        inputAudioSeconds: 2,
      },
    });
    expect(fetchImplementation).not.toHaveBeenCalled();

    await expect(
      client.speak({
        budgetExceededAction: 'warn',
        budgetUsd: 0,
        estimatedOutputSeconds: 2,
        input: 'warn',
      }),
    ).resolves.toMatchObject({ provider: 'openai' });
    await expect(
      client.transcribe({
        budgetExceededAction: 'warn',
        budgetUsd: 0,
        input: {
          file: new Uint8Array([1]),
          mediaType: 'audio/mpeg',
        },
        inputAudioSeconds: 2,
      }),
    ).resolves.toMatchObject({ text: 'done' });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledTimes(2);
    expect(usageLogger.log).not.toHaveBeenCalled();
    expect(usageLogger.logSpeech).toHaveBeenCalledTimes(4);
    expect(
      usageLogger.logSpeech.mock.calls.map(([event]) => event.kind),
    ).toEqual(['speech', 'transcription', 'speech', 'transcription']);
    expect(usageLogger.logSpeech.mock.calls[0]?.[0]).toMatchObject({
      kind: 'speech',
      speechUsage: {
        billingUnits: expect.objectContaining({ outputAudioSeconds: 2 }),
        costUSD: 0,
      },
    });
    expect(usageLogger.logSpeech.mock.calls[1]?.[0]).toMatchObject({
      kind: 'transcription',
      speechUsage: {
        billingUnits: expect.objectContaining({ inputAudioSeconds: 2 }),
        costUSD: 0,
      },
    });
  });

  it('enforces speech budgets and logging without consuming mock queues on skip', async () => {
    const modelRegistry = new ModelRegistry({
      'paid-mock': {
        contextWindow: 1_000,
        inputPrice: 1,
        kind: 'completion',
        lastUpdated: '2026-07-13',
        outputPrice: 1,
        provider: 'mock',
        supportsStreaming: true,
        supportsTools: false,
        supportsVision: false,
      },
    });
    const speechWarn = vi.fn(() => mockSpeechResponse('warn'));
    const speechAfterSkip = vi.fn(() => mockSpeechResponse('after-skip'));
    const transcriptionWarn = vi.fn(() =>
      mockTranscriptionResponse('warn transcript'),
    );
    const transcriptionAfterSkip = vi.fn(() =>
      mockTranscriptionResponse('after skip transcript'),
    );
    const onWarning = vi.fn();
    const usageLogger = {
      log: vi.fn(async () => undefined),
      logSpeech: vi.fn(async (_event: SpeechUsageEvent) => undefined),
    };
    const client = LLMClient.mock({
      defaultModel: 'paid-mock',
      modelRegistry,
      onWarning,
      speeches: [speechWarn, speechAfterSkip],
      transcriptions: [transcriptionWarn, transcriptionAfterSkip],
      usageLogger,
    });

    expect(client.models.get('mock-speech-model').speechPrices).toMatchObject({
      outputAudioSecondPrice: expect.any(Number),
    });
    expect(
      client.models.get('mock-transcription-model').speechPrices,
    ).toMatchObject({ inputAudioSecondPrice: expect.any(Number) });

    await expect(
      client.speak({
        budgetExceededAction: 'throw',
        budgetUsd: 0,
        estimatedOutputSeconds: 10,
        input: 'throw',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(
      client.transcribe({
        budgetExceededAction: 'throw',
        budgetUsd: 0,
        input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
        inputAudioSeconds: 10,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(speechWarn).not.toHaveBeenCalled();
    expect(transcriptionWarn).not.toHaveBeenCalled();
    expect(usageLogger.logSpeech).not.toHaveBeenCalled();

    await client.speak({
      budgetExceededAction: 'warn',
      budgetUsd: 0,
      estimatedOutputSeconds: 10,
      input: 'warn',
    });
    await client.transcribe({
      budgetExceededAction: 'warn',
      budgetUsd: 0,
      input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
      inputAudioSeconds: 10,
    });
    expect(speechWarn).toHaveBeenCalledOnce();
    expect(transcriptionWarn).toHaveBeenCalledOnce();
    expect(onWarning).toHaveBeenCalledTimes(2);

    const skippedSpeech = await client.speak({
      budgetExceededAction: 'skip',
      budgetUsd: 0,
      estimatedOutputSeconds: 10,
      input: 'skip',
    });
    const skippedTranscription = await client.transcribe({
      budgetExceededAction: 'skip',
      budgetUsd: 0,
      input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
      inputAudioSeconds: 10,
    });
    expect(skippedSpeech.usage).toMatchObject({
      costUSD: 0,
      outputAudioSeconds: 10,
    });
    expect(skippedTranscription.usage).toMatchObject({
      costUSD: 0,
      inputAudioSeconds: 10,
    });
    expect(speechAfterSkip).not.toHaveBeenCalled();
    expect(transcriptionAfterSkip).not.toHaveBeenCalled();

    await client.speak({ input: 'consume remaining speech' });
    await client.transcribe({
      input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
    });
    expect(speechAfterSkip).toHaveBeenCalledOnce();
    expect(transcriptionAfterSkip).toHaveBeenCalledOnce();
    expect(usageLogger.log).not.toHaveBeenCalled();
    expect(usageLogger.logSpeech).toHaveBeenCalledTimes(6);
    expect(
      usageLogger.logSpeech.mock.calls.map(([event]) => event.kind),
    ).toEqual([
      'speech',
      'transcription',
      'speech',
      'transcription',
      'speech',
      'transcription',
    ]);
  });

  it('derives transcription budget seconds locally and prefers explicit duration', async () => {
    const transcriptionFactory = vi.fn(() => mockTranscriptionResponse('ok'));
    const client = LLMClient.mock({ transcriptions: [transcriptionFactory] });
    const wav = makeWavBytes({ seconds: 2 });
    const arrayBuffer = new ArrayBuffer(wav.byteLength);
    new Uint8Array(arrayBuffer).set(wav);

    for (const input of [
      { file: wav, mediaType: 'audio/wav' as const },
      { file: arrayBuffer, mediaType: 'audio/x-wav' as const },
      {
        data: Buffer.from(wav).toString('base64'),
        mediaType: 'audio/wav' as const,
      },
    ]) {
      await expect(
        client.transcribe({ budgetUsd: 0, input }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
    }
    expect(transcriptionFactory).not.toHaveBeenCalled();

    await expect(
      client.transcribe({
        budgetUsd: 0.00006,
        input: { file: wav, mediaType: 'audio/wav' },
        inputAudioSeconds: 1,
      }),
    ).resolves.toMatchObject({ text: 'ok' });
    expect(transcriptionFactory).toHaveBeenCalledOnce();

    const fetchImplementation = vi.fn();
    const realClient = new LLMClient({
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });
    await expect(
      realClient.transcribe({
        budgetUsd: 1,
        input: {
          mediaType: 'audio/mpeg',
          url: 'https://example.test/audio.mp3',
        },
      }),
    ).rejects.toThrow('inputAudioSeconds');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('merges mock speech prices without overriding explicit custom prices', () => {
    const modelRegistry = new ModelRegistry({
      'mock-speech-model': {
        contextWindow: 2_000,
        inputPrice: 0,
        kind: 'speech',
        lastUpdated: '2026-07-13',
        outputPrice: 0,
        provider: 'mock',
        speechPrices: { outputAudioSecondPrice: 0.123 },
        supportsStreaming: false,
        supportsTools: false,
        supportsVision: false,
      },
    });
    const client = LLMClient.mock({ modelRegistry });

    expect(client.models.get('mock-speech-model').speechPrices).toEqual({
      outputAudioSecondPrice: 0.123,
      textInputTokenPrice: 0.6,
    });
    expect(client.models.list().some(({ id }) => id === 'unknown-speech')).toBe(
      false,
    );
  });

  it('rejects invalid budgets before routing or consuming mock queues', async () => {
    const responseFactory = vi.fn(() => ({
      content: [],
      finishReason: 'stop' as const,
      model: 'mock-model',
      provider: 'mock' as const,
      raw: {},
      text: 'ok',
      toolCalls: [],
      usage: {
        cachedTokens: 0,
        cost: '$0.00',
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    }));
    const client = LLMClient.mock({ responses: [responseFactory] });
    const request = {
      messages: [{ content: 'Hello', role: 'user' as const }],
    };

    for (const budgetUsd of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '1',
      null,
    ]) {
      await expect(
        client.complete({
          ...request,
          budgetUsd: budgetUsd as number,
        }),
      ).rejects.toMatchObject({
        details: expect.objectContaining({ code: 'invalid_budget' }),
        statusCode: 400,
      });
    }
    expect(responseFactory).not.toHaveBeenCalled();
    await expect(
      client.complete({ ...request, budgetUsd: 0.5 }),
    ).resolves.toMatchObject({
      text: 'ok',
    });
    expect(responseFactory).toHaveBeenCalledOnce();
    expect(() => client.stream({ ...request, budgetUsd: Number.NaN })).toThrow(
      ProviderCapabilityError,
    );
    expect(() =>
      client.resolveContext({
        ...request,
        budgetUsd: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(ProviderCapabilityError);
  });

  it('rejects invalid provider cache options before consuming mock queues', async () => {
    const openAIGetter = vi.fn(() => 'secret');
    const openAIPromptCaching = Object.defineProperty({}, 'key', {
      enumerable: true,
      get: openAIGetter,
    });
    const anthropicGetter = vi.fn(() => '5m');
    const anthropicCacheControl = Object.defineProperty(
      { type: 'ephemeral' },
      'ttl',
      {
        enumerable: true,
        get: anthropicGetter,
      },
    );
    const client = LLMClient.mock({
      responses: [
        {
          content: [{ text: 'queued response', type: 'text' }],
          finishReason: 'stop',
          model: 'mock-model',
          provider: 'mock',
          raw: { queued: true },
          text: 'queued response',
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
      streams: [[{ delta: 'queued stream', type: 'text-delta' }]],
    });
    const messages = [{ content: 'Hello', role: 'user' as const }];
    const invalidProviderOptions = [
      {
        openai: {
          promptCaching: { retention: '24h', unknown: true },
        },
      },
      { openai: { promptCaching: openAIPromptCaching } },
      {
        anthropic: {
          cacheControl: { type: 'ephemeral', unknown: true },
        },
      },
      { anthropic: { cacheControl: anthropicCacheControl } },
    ];

    for (const providerOptions of invalidProviderOptions) {
      await expect(
        client.complete({ messages, providerOptions } as never),
      ).rejects.toMatchObject({
        name: 'ProviderCapabilityError',
        statusCode: 400,
      });
      expect(() =>
        client.stream({ messages, providerOptions } as never),
      ).toThrow(ProviderCapabilityError);
    }
    expect(openAIGetter).not.toHaveBeenCalled();
    expect(anthropicGetter).not.toHaveBeenCalled();

    await expect(client.complete({ messages })).resolves.toMatchObject({
      raw: { queued: true },
      text: 'queued response',
    });
    const chunks = [];
    for await (const chunk of client.stream({ messages })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delta: 'queued stream',
          type: 'text-delta',
        }),
      ]),
    );
  });

  it('validates mock speech and transcription before queue consumption', async () => {
    const speechFactory = vi.fn(() => ({
      audio: new Uint8Array([1]),
      format: 'mp3' as const,
      mediaType: 'audio/mpeg',
      model: 'mock-speech-model',
      provider: 'mock' as const,
      raw: {},
    }));
    const transcriptionFactory = vi.fn(() => ({
      model: 'mock-transcription-model',
      provider: 'mock' as const,
      raw: {},
      text: 'ok',
    }));
    const client = LLMClient.mock({
      speeches: [speechFactory],
      transcriptions: [transcriptionFactory],
    });
    const speechGetter = vi.fn(() => 'secret speech');
    const speechAccessor = Object.defineProperty({}, 'input', {
      enumerable: true,
      get: speechGetter,
    });

    for (const request of [
      { input: '' },
      { input: ' ', speed: 1 },
      { input: 'hello', speed: 0 },
      { input: 'hello', speed: Number.NaN },
      { estimatedOutputSeconds: -1, input: 'hello' },
      { input: 'hello', voice: 'unknown' },
      { input: 'hello', unknown: true },
      speechAccessor,
    ]) {
      await expect(client.speak(request as never)).rejects.toBeInstanceOf(
        ProviderCapabilityError,
      );
    }
    expect(speechFactory).not.toHaveBeenCalled();
    expect(speechGetter).not.toHaveBeenCalled();
    await expect(
      client.speak({ input: 'hello', voice: { id: 'custom-voice' } }),
    ).resolves.toMatchObject({ format: 'mp3' });
    expect(speechFactory).toHaveBeenCalledOnce();

    const transcriptionGetter = vi.fn(() => ({
      file: new Uint8Array([1]),
      mediaType: 'audio/mpeg',
    }));
    const transcriptionAccessor = Object.defineProperty({}, 'input', {
      enumerable: true,
      get: transcriptionGetter,
    });
    for (const input of [
      { mediaType: 'audio/mpeg' },
      {
        data: Buffer.from('x').toString('base64'),
        file: new Uint8Array([1]),
        mediaType: 'audio/mpeg',
      },
      { data: 'not base64', mediaType: 'audio/mpeg' },
      { file: new Uint8Array(), mediaType: 'audio/mpeg' },
      { file: new Uint8Array([1]), mediaType: 'text/plain' },
    ]) {
      await expect(
        client.transcribe({ input } as never),
      ).rejects.toBeInstanceOf(ProviderCapabilityError);
    }
    await expect(
      client.transcribe({
        input: {
          file: new Uint8Array([1]),
          mediaType: 'audio/mpeg',
        },
        unknown: true,
      } as never),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    await expect(
      client.transcribe(transcriptionAccessor as never),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(transcriptionFactory).not.toHaveBeenCalled();
    expect(transcriptionGetter).not.toHaveBeenCalled();
    await expect(
      client.transcribe({
        input: {
          file: new Uint8Array([1]),
          mediaType: 'audio/mpeg',
        },
        inputAudioSeconds: 0.5,
      }),
    ).resolves.toMatchObject({ text: 'ok' });
    expect(transcriptionFactory).toHaveBeenCalledOnce();
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
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;

        expect(body.prompt_cache_key).toBe('support-faq-v1');
        expect(body.prompt_cache_retention).toBe('24h');

        return new Response(
          JSON.stringify({
            id: 'resp_1',
            model: 'gpt-4o',
            object: 'response',
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: 'Cached OpenAI response',
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
              input_tokens: 10,
              output_tokens: 5,
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        );
      },
    );

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
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;

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
      },
    );

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
    const fetchImplementation = vi.fn(
      async () =>
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

    expect(chunks.find((chunk) => chunk.type === 'text-delta')).toEqual(
      expect.objectContaining({ delta: 'Hi', version: 3 }),
    );
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    );
  });

  it('routes stream() calls to Gemini by model', async () => {
    const fetchImplementation = vi.fn(
      async () =>
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

    expect(chunks.find((chunk) => chunk.type === 'text-delta')).toEqual(
      expect.objectContaining({ delta: 'Hello from Gemini', version: 3 }),
    );
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    );
  });

  it('preserves explicitly supplied versions in routed and mock stream decorators', async () => {
    const legacyArguments = {
      id: 'legacy-call',
      name: 'weather',
      result: { city: 'Paris' },
      type: 'tool-call-result',
      version: 2,
    } as unknown as StreamChunk;
    const routedClient = new LLMClient({
      defaultModel: 'gpt-4o-mini',
      openaiApiKey: 'openai-key',
    });
    const routedAdapter = (
      routedClient as unknown as {
        openaiAdapter: {
          stream: () => AsyncIterable<StreamChunk>;
        };
      }
    ).openaiAdapter;
    routedAdapter.stream = async function* () {
      yield legacyArguments;
    };

    const routedChunks: StreamChunk[] = [];
    for await (const chunk of routedClient.stream({
      messages: [{ content: 'route legacy arguments', role: 'user' }],
    })) {
      routedChunks.push(chunk);
    }

    const mockClient = LLMClient.mock({
      streams: [[legacyArguments]],
    });
    const mockChunks: StreamChunk[] = [];
    for await (const chunk of mockClient.stream({
      messages: [{ content: 'mock legacy arguments', role: 'user' }],
    })) {
      mockChunks.push(chunk);
    }

    expect(
      routedChunks.find((chunk) => chunk.type === 'tool-call-result'),
    ).toMatchObject({ version: 2 });
    expect(
      mockChunks.find((chunk) => chunk.type === 'tool-call-result'),
    ).toMatchObject({ version: 2 });
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
      const fetchImplementation = vi.fn(
        async () =>
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

  it('parses structured output and sends provider request format through complete()', async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;
        expect(request).toMatchObject({
          text: {
            format: {
              schema: {
                additionalProperties: false,
                properties: {
                  answer: { type: 'string' },
                },
                required: ['answer'],
                type: 'object',
              },
              strict: true,
              type: 'json_schema',
            },
          },
        });

        return new Response(
          JSON.stringify({
            id: 'resp_1',
            model: 'gpt-4o',
            object: 'response',
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: '{"answer":"ok"}',
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
        );
      },
    );
    const client = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });

    const response = await client.complete({
      messages: [{ content: 'Return the result.', role: 'user' }],
      responseFormat: {
        schema: {
          properties: {
            answer: { type: 'string' },
          },
          type: 'object',
        },
        type: 'json_schema',
      },
    });

    expect(response.parsed).toEqual({ answer: 'ok' });
    expect(response.responseFormat).toBe('json_schema');
    expect(response.structuredOutputStatus).toBe('parsed');
  });

  it('rejects structured output for custom models without explicit capability flags', async () => {
    const fetchImplementation = vi.fn();
    const client = new LLMClient({
      defaultModel: 'custom-openai',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });
    client.models.register({
      contextWindow: 8192,
      id: 'custom-openai',
      inputPrice: 1,
      kind: 'completion',
      lastUpdated: '2026-04-15',
      outputPrice: 1,
      provider: 'openai',
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false,
    });

    await expect(
      client.complete({
        messages: [{ content: 'Return JSON.', role: 'user' }],
        responseFormat: { type: 'json_object' },
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(fetchImplementation).not.toHaveBeenCalled();
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
      requestId: 'mock-request',
    })) {
      chunks.push(chunk);
    }

    expect(response.text).toBe('Mock queue');
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'response-start',
      'text-delta',
      'usage-update',
      'done',
    ]);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([1, 2, 3, 4]);
    expect(chunks.every((chunk) => chunk.version === 3)).toBe(true);
    expect(chunks.every((chunk) => chunk.requestId === 'mock-request')).toBe(
      true,
    );
    expect(chunks.every((chunk) => typeof chunk.timestamp === 'string')).toBe(
      true,
    );
  });

  it('parses structured output responses through LLMClient.mock()', async () => {
    const client = LLMClient.mock({
      responses: [
        {
          content: [{ text: '{"answer":"mock"}', type: 'text' }],
          finishReason: 'stop',
          model: 'mock-model',
          provider: 'mock',
          raw: {},
          text: '{"answer":"mock"}',
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
    });

    const response = await client.complete({
      messages: [{ content: 'Hello', role: 'user' }],
      responseFormat: {
        schema: {
          properties: {
            answer: { type: 'string' },
          },
          type: 'object',
        },
        type: 'json_schema',
      },
    });

    expect(response.parsed).toEqual({ answer: 'mock' });
    expect(response.structuredOutputStatus).toBe('parsed');
  });

  it('throws for unimplemented providers in complete() and stream()', async () => {
    const client = new LLMClient();
    client.models.register({
      contextWindow: 64000,
      id: 'mock-llm',
      inputPrice: 1,
      kind: 'completion',
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
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          model?: string;
          stream?: boolean;
        };
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
      },
    );
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
      metadata: { feature: 'stream-correlation' },
      messages: [{ content: 'Hello', role: 'user' }],
      requestId: 'stream-request-123',
      sessionId: 'stream-session',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.find((chunk) => chunk.type === 'text-delta')).toEqual(
      expect.objectContaining({ delta: 'Fallback stream', version: 3 }),
    );
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        finishReason: 'stop',
        type: 'done',
      }),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(usageLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { feature: 'stream-correlation' },
        requestId: 'stream-request-123',
        routingDecision:
          'rule:stream-fallback:primary:gpt-4o -> rule:stream-fallback:fallback:1:gpt-4o-mini',
        sessionId: 'stream-session',
      }),
    );
  });

  it('does not fall back after streaming has already emitted output', async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          model?: string;
        };
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
      },
    );
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
    expect(chunks).toContainEqual(
      expect.objectContaining({
        delta: 'partial',
        type: 'text-delta',
        version: 3,
      }),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('warns once across routed fallback attempts for complete and stream', async () => {
    const makeRouter = () =>
      new ModelRouter({
        rules: [
          {
            fallback: ['gpt-4o-mini'],
            name: 'budget-warning-fallback',
            target: 'gpt-4o',
          },
        ],
      });
    const warnings: string[] = [];
    const onWarning = (message: string) => {
      warnings.push(message);
      throw new Error('SECRET_WARNING_CALLBACK_FAILURE');
    };
    const completeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'retry' } }), {
          headers: { 'content-type': 'application/json' },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'resp_budget_fallback',
            model: 'gpt-4o-mini',
            object: 'response',
            output: [
              {
                content: [
                  {
                    annotations: [],
                    text: 'complete fallback',
                    type: 'output_text',
                  },
                ],
                id: 'msg_budget_fallback',
                role: 'assistant',
                status: 'completed',
                type: 'message',
              },
            ],
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    const completeClient = new LLMClient({
      fetchImplementation: completeFetch,
      modelRouter: makeRouter(),
      onWarning,
      openaiApiKey: 'openai-key',
      retryOptions: { baseMs: 0, jitterMs: 0, maxAttempts: 1 },
    });
    await expect(
      completeClient.complete({
        budgetExceededAction: 'warn',
        budgetUsd: 0,
        maxTokens: 8,
        messages: [{ content: 'SECRET_COMPLETE_PROMPT', role: 'user' }],
      }),
    ).resolves.toMatchObject({ text: 'complete fallback' });
    expect(warnings).toHaveLength(1);

    warnings.length = 0;
    const streamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'retry' } }), {
          headers: { 'content-type': 'application/json' },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    content_index: 0,
                    delta: 'stream fallback',
                    item_id: 'msg_stream_budget',
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
                      id: 'resp_stream_budget',
                      model: 'gpt-4o-mini',
                      object: 'response',
                      output: [
                        {
                          content: [
                            {
                              annotations: [],
                              text: 'stream fallback',
                              type: 'output_text',
                            },
                          ],
                          id: 'msg_stream_budget',
                          role: 'assistant',
                          status: 'completed',
                          type: 'message',
                        },
                      ],
                      status: 'completed',
                      usage: { input_tokens: 1, output_tokens: 1 },
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
    const streamClient = new LLMClient({
      fetchImplementation: streamFetch,
      modelRouter: makeRouter(),
      onWarning,
      openaiApiKey: 'openai-key',
      retryOptions: { baseMs: 0, jitterMs: 0, maxAttempts: 1 },
    });
    await collectClientStream(
      streamClient.stream({
        budgetExceededAction: 'warn',
        budgetUsd: 0,
        maxTokens: 8,
        messages: [{ content: 'SECRET_STREAM_PROMPT', role: 'user' }],
      }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings.join(' ')).not.toMatch(
      /SECRET_COMPLETE_PROMPT|SECRET_STREAM_PROMPT|SECRET_WARNING_CALLBACK_FAILURE|openai-key/,
    );
  });

  it('logs usage events for successful requests', async () => {
    const usageLogger = {
      log: vi.fn(async () => undefined),
    };
    const fetchImplementation = vi.fn(
      async () =>
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
      metadata: {
        feature: 'usage-correlation',
        nested: { attempt: 1 },
      },
      messages: [{ content: 'Hello', role: 'user' }],
      requestId: 'request-123',
      sessionId: 'usage-session',
      tenantId: 'tenant-2',
    });

    expect(usageLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        metadata: {
          feature: 'usage-correlation',
          nested: { attempt: 1 },
        },
        model: 'gpt-4o',
        provider: 'openai',
        requestId: 'request-123',
        routingDecision: 'default:gpt-4o',
        sessionId: 'usage-session',
        tenantId: 'tenant-2',
      }),
    );
  });

  it('swallows usage logger failures', async () => {
    const fetchImplementation = vi.fn(
      async () =>
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

  it('includes explicit Gemini thinking budgets in per-call budget guards', async () => {
    const fetchImplementation = vi.fn();
    const client = new LLMClient({
      defaultModel: 'gemini-2.5-flash',
      fetchImplementation,
      geminiApiKey: 'gemini-key',
    });

    await expect(
      client.complete({
        budgetUsd: 0.0001,
        maxTokens: 1,
        messages: [{ content: 'Hello', role: 'user' }],
        providerOptions: {
          google: {
            thinking: {
              budgetTokens: 1000,
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        estimatedReasoningTokens: 1000,
      }),
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('can warn and continue when a request exceeds the per-call budget', async () => {
    const onWarning = vi.fn();
    const fetchImplementation = vi.fn(
      async () =>
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

  it('enforces throw, warn, and skip before mock complete queue consumption', async () => {
    const request = {
      budgetUsd: 0,
      maxTokens: 8,
      messages: [{ content: 'SECRET_PROMPT_VALUE', role: 'user' as const }],
      metadata: { secret: 'SECRET_METADATA_VALUE' },
      model: 'paid-mock',
    };
    const throwFactory = vi.fn(() => mockCompletionResponse('throw-reused'));
    const throwClient = LLMClient.mock({
      modelRegistry: paidMockRegistry(),
      responses: [throwFactory],
    });
    await expect(
      throwClient.complete({
        ...request,
        budgetExceededAction: 'throw',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(throwFactory).not.toHaveBeenCalled();
    await expect(
      throwClient.complete({ ...request, budgetUsd: 1 }),
    ).resolves.toMatchObject({ text: 'throw-reused' });

    const usageLogger = { log: vi.fn(async () => undefined) };
    const skipFactory = vi.fn(() => mockCompletionResponse('skip-reused'));
    const skipClient = LLMClient.mock({
      modelRegistry: paidMockRegistry(),
      responses: [skipFactory],
      usageLogger,
    });
    await expect(
      skipClient.complete({
        ...request,
        budgetExceededAction: 'skip',
      }),
    ).resolves.toMatchObject({
      finishReason: 'error',
      raw: { reason: 'budget_exceeded', skipped: true },
      usage: { costUSD: 0, inputTokens: 0, outputTokens: 0 },
    });
    expect(skipFactory).not.toHaveBeenCalled();
    expect(usageLogger.log).toHaveBeenCalledTimes(1);
    expect(usageLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ costUSD: 0, finishReason: 'error' }),
    );
    await skipClient.complete({ ...request, budgetUsd: 1 });
    expect(skipFactory).toHaveBeenCalledOnce();

    const warnings: string[] = [];
    const warnFactory = vi.fn(() => mockCompletionResponse('warned'));
    const warnClient = LLMClient.mock({
      modelRegistry: paidMockRegistry(),
      onWarning: (message) => {
        warnings.push(message);
        throw new Error('SECRET_CALLBACK_ERROR');
      },
      responses: [warnFactory],
    });
    await expect(
      warnClient.complete({
        ...request,
        budgetExceededAction: 'warn',
      }),
    ).resolves.toMatchObject({ text: 'warned' });
    expect(warnFactory).toHaveBeenCalledOnce();
    expect(warnings).toHaveLength(1);
    expect(warnings.join(' ')).not.toMatch(
      /SECRET_PROMPT_VALUE|SECRET_METADATA_VALUE|SECRET_CALLBACK_ERROR/,
    );
  });

  it('enforces throw, warn, and skip before mock stream queue consumption', async () => {
    const request = {
      budgetUsd: 0,
      maxTokens: 8,
      messages: [{ content: 'stream secret', role: 'user' as const }],
      model: 'paid-mock',
    };
    const reusableStream: StreamChunk[] = [
      { delta: 'ok', type: 'text-delta' },
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
    ];
    const throwFactory = vi.fn(() => reusableStream);
    const throwClient = LLMClient.mock({
      modelRegistry: paidMockRegistry(),
      streams: [throwFactory],
    });
    await expect(
      collectClientStream(throwClient.stream(request)),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(throwFactory).not.toHaveBeenCalled();
    await collectClientStream(throwClient.stream({ ...request, budgetUsd: 1 }));
    expect(throwFactory).toHaveBeenCalledOnce();

    const usageLogger = { log: vi.fn(async () => undefined) };
    const skipFactory = vi.fn(() => reusableStream);
    const skipClient = LLMClient.mock({
      modelRegistry: paidMockRegistry(),
      streams: [skipFactory],
      usageLogger,
    });
    const skipped = await collectClientStream(
      skipClient.stream({ ...request, budgetExceededAction: 'skip' }),
    );
    expect(skipped.map((chunk) => chunk.type)).toEqual([
      'error',
      'text-delta',
      'done',
    ]);
    expect(skipFactory).not.toHaveBeenCalled();
    expect(usageLogger.log).toHaveBeenCalledTimes(1);
    await collectClientStream(skipClient.stream({ ...request, budgetUsd: 1 }));
    expect(skipFactory).toHaveBeenCalledOnce();

    const onWarning = vi.fn(() => {
      throw new Error('warning observer failed');
    });
    const warnFactory = vi.fn(() => reusableStream);
    const warnClient = LLMClient.mock({
      modelRegistry: paidMockRegistry(),
      onWarning,
      streams: [warnFactory],
    });
    await expect(
      collectClientStream(
        warnClient.stream({ ...request, budgetExceededAction: 'warn' }),
      ),
    ).resolves.toEqual(expect.any(Array));
    expect(onWarning).toHaveBeenCalledOnce();
    expect(warnFactory).toHaveBeenCalledOnce();
  });

  it('enforces real stream throw and skip before fetch with one skip event', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const throwClient = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
    });
    const request = {
      budgetUsd: 0,
      maxTokens: 8,
      messages: [{ content: 'stream budget', role: 'user' as const }],
    };
    await expect(
      collectClientStream(
        throwClient.stream({
          ...request,
          budgetExceededAction: 'throw',
        }),
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImplementation).not.toHaveBeenCalled();

    const usageLogger = { log: vi.fn(async () => undefined) };
    const skipClient = new LLMClient({
      defaultModel: 'gpt-4o',
      fetchImplementation,
      openaiApiKey: 'openai-key',
      usageLogger,
    });
    const chunks = await collectClientStream(
      skipClient.stream({ ...request, budgetExceededAction: 'skip' }),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'error',
      'text-delta',
      'done',
    ]);
    expect(chunks.at(-1)).toMatchObject({
      finishReason: 'error',
      usage: { costUSD: 0, inputTokens: 0, outputTokens: 0 },
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(usageLogger.log).toHaveBeenCalledOnce();
    expect(usageLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ costUSD: 0, finishReason: 'error' }),
    );
  });

  it('exposes a cancel() contract for streaming requests', async () => {
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      },
    );
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

  it('stops yielding already-buffered provider stream chunks after cancel()', async () => {
    const encoder = new TextEncoder();
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of [
                {
                  content_index: 0,
                  delta: 'first',
                  item_id: 'msg_1',
                  output_index: 0,
                  sequence_number: 1,
                  type: 'response.output_text.delta',
                },
                {
                  content_index: 0,
                  delta: 'second',
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
                    output: [],
                    status: 'completed',
                    usage: {
                      input_tokens: 5,
                      output_tokens: 3,
                    },
                  },
                  sequence_number: 3,
                  type: 'response.completed',
                },
              ]) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                );
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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

    const stream = client.stream({
      messages: [{ content: 'Cancel after one chunk', role: 'user' }],
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({ type: 'response-start', version: 3 }),
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        delta: 'first',
        type: 'text-delta',
        version: 3,
      }),
    });

    stream.cancel(new Error('manual cancel'));

    await expect(iterator.next()).rejects.toThrow('manual cancel');
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
          totalReasoningTokens: 3,
        },
      ],
      requestCount: 2,
      totalCachedTokens: 4,
      totalCostUSD: 0.03,
      totalInputTokens: 20,
      totalOutputTokens: 8,
      totalReasoningTokens: 3,
    };
    const usageLogger = {
      getUsage: vi.fn(async () => summary),
      log: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      usageLogger,
    });

    await expect(client.getUsage({ tenantId: 'tenant-1' })).resolves.toEqual(
      summary,
    );
    expect(usageLogger.getUsage).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
  });

  it('throws from getUsage() when aggregation is not configured', async () => {
    const client = new LLMClient();

    await expect(client.getUsage()).rejects.toBeInstanceOf(
      ProviderCapabilityError,
    );
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
            totalReasoningTokens: 2,
          },
        ],
        requestCount: 1,
        totalCachedTokens: 0,
        totalCostUSD: 0.01,
        totalInputTokens: 10,
        totalOutputTokens: 4,
        totalReasoningTokens: 2,
      })),
      log: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      usageLogger,
    });

    await expect(client.exportUsage('csv')).resolves.toContain(
      'provider,model,requestCount,totalInputTokens,totalOutputTokens,totalReasoningTokens,totalCachedTokens,totalCostUSD',
    );
  });

  it('delegates getSpeechUsage() to the configured usage logger', async () => {
    const summary: SpeechUsageSummary = {
      breakdown: [
        {
          kind: 'speech',
          model: 'gpt-4o-mini-tts',
          provider: 'openai',
          requestCount: 1,
          totalAudioInputSeconds: 0,
          totalAudioOutputSeconds: 3,
          totalCostUSD: 0.001,
          totalInputCharacters: 12,
          totalInputTokens: 3,
          totalOutputCharacters: 0,
          totalOutputTokens: 0,
        },
      ],
      requestCount: 1,
      totalAudioInputSeconds: 0,
      totalAudioOutputSeconds: 3,
      totalCostUSD: 0.001,
      totalInputCharacters: 12,
      totalInputTokens: 3,
      totalOutputCharacters: 0,
      totalOutputTokens: 0,
    };
    const usageLogger = {
      getSpeechUsage: vi.fn(async () => summary),
      log: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      usageLogger,
    });

    await expect(
      client.getSpeechUsage({ tenantId: 'tenant-1' }),
    ).resolves.toEqual(summary);
    expect(usageLogger.getSpeechUsage).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
    });
  });

  it('exports aggregated speech usage as CSV through the client surface', async () => {
    const usageLogger = {
      getSpeechUsage: vi.fn(async () => ({
        breakdown: [
          {
            kind: 'transcription' as const,
            model: 'gpt-4o-mini-transcribe',
            provider: 'openai' as const,
            requestCount: 1,
            totalAudioInputSeconds: 2,
            totalAudioOutputSeconds: 0,
            totalCostUSD: 0.0001,
            totalInputCharacters: 0,
            totalInputTokens: 0,
            totalOutputCharacters: 11,
            totalOutputTokens: 3,
          },
        ],
        requestCount: 1,
        totalAudioInputSeconds: 2,
        totalAudioOutputSeconds: 0,
        totalCostUSD: 0.0001,
        totalInputCharacters: 0,
        totalInputTokens: 0,
        totalOutputCharacters: 11,
        totalOutputTokens: 3,
      })),
      log: vi.fn(async () => undefined),
    };
    const client = new LLMClient({
      usageLogger,
    });

    await expect(client.exportSpeechUsage('csv')).resolves.toContain(
      'provider,model,kind,requestCount,totalInputTokens,totalOutputTokens,totalInputCharacters,totalOutputCharacters,totalAudioInputSeconds,totalAudioOutputSeconds,totalCostUSD',
    );
  });

  it('OpenAI conversation loop: store:false, no previous_response_id, full history re-sent every turn', async () => {
    const capturedBodies: Record<string, unknown>[] = [];

    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBodies.push(
          JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        );
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
      },
    );

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
    expect(secondInputMessages.length).toBeGreaterThan(
      firstInputMessages.length,
    );

    const replayedAssistantMessage = secondInput.find(
      (item) => (item as { role?: string }).role === 'assistant',
    ) as { content?: unknown[] } | undefined;
    expect(replayedAssistantMessage?.content).toEqual([
      { text: 'First reply', type: 'output_text' },
    ]);
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

  it('rejects non-JSON metadata before mock queue mutation or streaming dispatch', async () => {
    const getter = vi.fn(() => 'secret');
    const accessorMetadata = {};
    Object.defineProperty(accessorMetadata, 'secret', {
      enumerable: true,
      get: getter,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolKey = { ok: true };
    Object.defineProperty(symbolKey, Symbol('hidden'), {
      enumerable: true,
      value: 'secret',
    });
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 34; index += 1) {
      deep = { nested: deep };
    }
    const sparseArray = Array(1);
    const customArray = [1];
    Object.defineProperty(customArray, 'extra', {
      enumerable: true,
      value: 'invalid',
    });
    const hiddenArray = [1];
    Object.defineProperty(hiddenArray, '0', {
      enumerable: false,
      value: 1,
    });
    const customPrototypeArray = [1];
    Object.setPrototypeOf(customPrototypeArray, null);
    const invalidMetadata: unknown[] = [
      { value: undefined },
      { value: 1n },
      { value: Symbol('invalid') },
      { value: () => undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      cyclic,
      { value: new Date() },
      accessorMetadata,
      symbolKey,
      deep,
      { value: sparseArray },
      { value: customArray },
      { value: hiddenArray },
      { value: customPrototypeArray },
    ];
    const responseFactory = vi.fn();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [responseFactory],
      streams: [[]],
    });

    for (const metadata of invalidMetadata) {
      await expect(
        client.complete({
          messages: [{ content: 'hello', role: 'user' }],
          metadata: metadata as Record<string, never>,
        }),
      ).rejects.toMatchObject({
        details: expect.objectContaining({
          code: 'invalid_metadata',
          option: 'metadata',
        }),
        name: 'ProviderCapabilityError',
        statusCode: 400,
      });
    }

    const adversarialKey = `bad\n\u202e${'x'.repeat(2_000)}`;
    const pathError = await client
      .complete({
        messages: [{ content: 'hello', role: 'user' }],
        metadata: {
          [adversarialKey]: 1n,
        } as unknown as Record<string, never>,
      })
      .catch((error: unknown) => error);
    expect(pathError).toBeInstanceOf(ProviderCapabilityError);
    const errorPath = (pathError as ProviderCapabilityError).details?.path;
    expect(errorPath).toEqual(expect.any(String));
    expect((errorPath as string).length).toBeLessThanOrEqual(256);
    expect(errorPath).not.toContain('\n');
    expect(errorPath).not.toContain('\u202e');
    expect(errorPath).toMatch(/^metadata\.bad\?/);
    expect(errorPath).toMatch(/\.\.\.$/);

    expect(() =>
      client.stream({
        messages: [{ content: 'hello', role: 'user' }],
        metadata: { invalid: 1n } as unknown as Record<string, never>,
      }),
    ).toThrow(ProviderCapabilityError);
    expect(responseFactory).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();

    const fetchImplementation = vi.fn();
    const providerClient = new LLMClient({
      fetchImplementation,
      openaiApiKey: 'test-key',
    });
    await expect(
      providerClient.complete({
        messages: [{ content: 'hello', role: 'user' }],
        metadata: { invalid: 1n } as unknown as Record<string, never>,
        model: 'gpt-4o-mini',
        provider: 'openai',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('accepts JSON metadata and snapshots it before request consumers observe it', async () => {
    let capturedMetadata: unknown;
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        (options) => {
          capturedMetadata = options.metadata;
          return {
            content: [],
            finishReason: 'stop',
            model: options.model,
            provider: options.provider,
            raw: {},
            text: '',
            toolCalls: [],
            usage: {
              cachedTokens: 0,
              cost: '$0.00',
              costUSD: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          };
        },
      ],
    });
    const nested = { enabled: true };
    const metadata = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        count: 1,
        nested,
        values: [null, 'ok', 2],
      },
    );

    await client.complete({
      messages: [{ content: 'hello', role: 'user' }],
      metadata: metadata as unknown as Record<string, never>,
    });
    nested.enabled = false;
    metadata.count = 99;

    expect(capturedMetadata).toEqual({
      count: 1,
      nested: { enabled: true },
      values: [null, 'ok', 2],
    });
    expect(capturedMetadata).not.toBe(metadata);
  });

  it('throws a typed error for all exhausted mock operation queues', async () => {
    const client = LLMClient.mock();
    const assertExhausted = async (
      operation: string,
      promise: Promise<unknown>,
    ): Promise<void> => {
      const error = await promise.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MockQueueExhaustedError);
      expect(error).toMatchObject({
        details: { code: 'mock_queue_exhausted', operation },
        retryable: false,
        statusCode: undefined,
      });
    };

    await assertExhausted(
      'complete',
      client.complete({ messages: [{ content: 'hello', role: 'user' }] }),
    );
    await assertExhausted('embed', client.embed({ input: 'hello' }));
    await assertExhausted('speak', client.speak({ input: 'hello' }));
    await assertExhausted(
      'transcribe',
      client.transcribe({
        input: {
          file: new Uint8Array([1, 2, 3]),
          mediaType: 'audio/wav',
        },
      }),
    );
    await assertExhausted(
      'stream',
      (async () => {
        for await (const chunk of client.stream({
          messages: [{ content: 'hello', role: 'user' }],
        })) {
          void chunk;
        }
      })(),
    );
  });

  it('does not consume a mock queue entry for a pre-aborted request', async () => {
    const abortReason = new Error('cancel before mock dispatch');
    const controller = new AbortController();
    controller.abort(abortReason);
    const response = {
      content: [],
      finishReason: 'stop' as const,
      model: 'mock-model',
      provider: 'mock' as const,
      raw: {},
      text: 'queued',
      toolCalls: [],
      usage: {
        cachedTokens: 0,
        cost: '$0.00',
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
    const client = LLMClient.mock({ responses: [response] });

    await expect(
      client.complete({
        messages: [{ content: 'first', role: 'user' }],
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    await expect(
      client.complete({
        messages: [{ content: 'second', role: 'user' }],
      }),
    ).resolves.toBe(response);

    const streamClient = LLMClient.mock({
      streams: [
        [
          { delta: 'queued', type: 'text-delta' },
          {
            finishReason: 'stop',
            type: 'done',
            usage: response.usage,
          },
        ],
      ],
    });
    const collect = async (signal?: AbortSignal): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of streamClient.stream({
        messages: [{ content: 'stream', role: 'user' }],
        ...(signal ? { signal } : {}),
      })) {
        chunks.push(chunk);
      }
      return chunks;
    };
    await expect(collect(controller.signal)).rejects.toBe(abortReason);
    await expect(collect()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delta: 'queued', type: 'text-delta' }),
      ]),
    );
  });

  it('consumes rejecting mock factories once and preserves concurrent FIFO', async () => {
    const factoryError = new Error('factory failed');
    const makeResponse = (text: string) => ({
      content: [{ text, type: 'text' as const }],
      finishReason: 'stop' as const,
      model: 'mock-model',
      provider: 'mock' as const,
      raw: {},
      text,
      toolCalls: [],
      usage: {
        cachedTokens: 0,
        cost: '$0.00',
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
    const client = LLMClient.mock({
      responses: [
        async () => Promise.reject(factoryError),
        async () => makeResponse('second'),
        async () => makeResponse('third'),
      ],
    });

    await expect(
      client.complete({ messages: [{ content: 'first', role: 'user' }] }),
    ).rejects.toBe(factoryError);
    const [second, third] = await Promise.all([
      client.complete({ messages: [{ content: 'second', role: 'user' }] }),
      client.complete({ messages: [{ content: 'third', role: 'user' }] }),
    ]);
    expect([second.text, third.text]).toEqual(['second', 'third']);
    await expect(
      client.complete({ messages: [{ content: 'fourth', role: 'user' }] }),
    ).rejects.toBeInstanceOf(MockQueueExhaustedError);
  });

  it('aborts an in-flight non-compliant fetch without logging or succeeding', async () => {
    const reason = new Error('disconnect');
    const controller = new AbortController();
    const usageLogger = { log: vi.fn(async () => undefined) };
    const fetchImplementation = vi.fn(
      async () => new Promise<Response>(() => undefined),
    );
    const client = new LLMClient({
      fetchImplementation,
      openaiApiKey: 'test',
      usageLogger,
    });
    const pending = client.complete({
      messages: [{ content: 'hello', role: 'user' }],
      model: 'gpt-4o-mini',
      signal: controller.signal,
    });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(usageLogger.log).not.toHaveBeenCalled();
  });

  it('does not route, fetch, or log a pre-aborted completion', async () => {
    const reason = new Error('already cancelled');
    const controller = new AbortController();
    controller.abort(reason);
    const router = new ModelRouter({
      rules: [{ name: 'primary', target: 'gpt-4o-mini' }],
    });
    const resolveRoute = vi.spyOn(router, 'resolve');
    const fetchImplementation = vi.fn();
    const usageLogger = { log: vi.fn(async () => undefined) };
    const client = new LLMClient({
      fetchImplementation,
      modelRouter: router,
      openaiApiKey: 'test',
      usageLogger,
    });

    await expect(
      client.complete({
        messages: [{ content: 'hello', role: 'user' }],
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(resolveRoute).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(usageLogger.log).not.toHaveBeenCalled();
  });

  it('does not route-fallback after a malformed successful response', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response('not-json', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
    );
    const client = new LLMClient({
      anthropicApiKey: 'anthropic',
      fetchImplementation,
      modelRouter: new ModelRouter({
        rules: [
          {
            fallback: ['claude-haiku-4-5'],
            name: 'malformed-no-fallback',
            target: 'gpt-4o-mini',
          },
        ],
      }),
      openaiApiKey: 'openai',
    });

    await expect(
      client.complete({
        messages: [{ content: 'hello', role: 'user' }],
      }),
    ).rejects.toMatchObject({
      details: { code: 'invalid_provider_response' },
      retryable: false,
      statusCode: 502,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('does not retry or route-fallback after an empty Gemini success', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: 'SECRET_ROUTED_THOUGHT',
                      thought: true,
                      thoughtSignature: 'secret-routed-signature',
                    },
                  ],
                },
                finishReason: 'STOP',
                index: 0,
              },
            ],
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
      ),
    );
    const client = new LLMClient({
      fetchImplementation,
      geminiApiKey: 'gemini',
      modelRouter: new ModelRouter({
        rules: [
          {
            fallback: ['gpt-4o-mini'],
            name: 'empty-gemini-no-fallback',
            target: 'gemini-2.5-flash',
          },
        ],
      }),
      openaiApiKey: 'openai',
    });

    const error = await client
      .complete({
        messages: [{ content: 'hello', role: 'user' }],
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      details: {
        code: 'invalid_provider_response',
        path: 'candidates[0].content.parts',
        reason: 'invalid_provider_response',
      },
      provider: 'google',
      retryable: false,
      statusCode: 502,
    });
    expect(JSON.stringify(error)).not.toContain('SECRET_ROUTED_THOUGHT');
    expect(JSON.stringify(error)).not.toContain('secret-routed-signature');
    expect(fetchImplementation).toHaveBeenCalledOnce();
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

  async query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number; rows: unknown[] }> {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    this.queries.push({ text: normalizedText, ...(values ? { values } : {}) });
    if (
      !/^(INSERT|SELECT)\b/i.test(normalizedText) ||
      this.queuedRows.length === 0
    ) {
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

function paidMockRegistry(): ModelRegistry {
  return new ModelRegistry({
    'paid-mock': {
      contextWindow: 8_192,
      inputPrice: 10,
      kind: 'completion',
      lastUpdated: '2026-07-13',
      outputPrice: 20,
      provider: 'mock',
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
    },
  });
}

function mockCompletionResponse(text: string) {
  return {
    content: [{ text, type: 'text' as const }],
    finishReason: 'stop' as const,
    model: 'paid-mock',
    provider: 'mock' as const,
    raw: {},
    text,
    toolCalls: [],
    usage: {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: 1,
      outputTokens: 1,
    },
  };
}

async function collectClientStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function mockSpeechResponse(marker: string) {
  return {
    audio: new Uint8Array([1]),
    format: 'mp3' as const,
    mediaType: 'audio/mpeg',
    model: 'mock-speech-model',
    provider: 'mock' as const,
    raw: { marker },
    usage: {
      cost: '$0.00',
      costUSD: 0,
      inputCharacters: 4,
    },
  };
}

function mockTranscriptionResponse(text: string) {
  return {
    model: 'mock-transcription-model',
    provider: 'mock' as const,
    raw: {},
    text,
    usage: {
      cost: '$0.00',
      costUSD: 0,
      inputAudioSeconds: 1,
    },
  };
}

function makeWavBytes(options: { seconds: number }): Uint8Array {
  const sampleRate = 24_000;
  const bytesPerSample = 2;
  const channels = 1;
  const dataSize = options.seconds * sampleRate * bytesPerSample * channels;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}
