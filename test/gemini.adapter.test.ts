import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import { copyGoogleReplayState } from '../src/internal/provider-replay-state.js';
import {
  GeminiAdapter,
  translateGeminiEmbeddingRequest,
  translateGeminiEmbeddingResponse,
  mapGeminiError,
  translateGeminiCacheCreateRequest,
  translateGeminiCacheUpdateRequest,
  translateGeminiRequest,
  translateGeminiResponse,
  translateGeminiToolChoice,
  translateGeminiTools,
} from '../src/providers/gemini.js';

describe('Gemini adapter', () => {
  it('translates canonical requests into generateContent payloads', () => {
    const request = translateGeminiRequest({
      maxTokens: 256,
      messages: [
        { content: 'You are helpful.', role: 'system' },
        {
          content: [
            { text: 'Hello', type: 'text' },
            { type: 'image_base64', data: 'abc123', mediaType: 'image/png' },
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
              name: 'weather_lookup',
              result: { temperature: 18 },
              toolCallId: 'call_1',
              type: 'tool_result',
            },
          ],
          role: 'user',
        },
      ],
      model: 'gemini-2.5-flash',
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
              nested: {
                properties: {
                  count: { type: 'integer' },
                },
                type: 'object',
              },
            },
            required: ['city'],
            type: 'object',
          },
        },
      ],
    });

    expect(request).toMatchObject({
      generationConfig: {
        maxOutputTokens: 256,
      },
      systemInstruction: {
        parts: [{ text: 'Pinned system' }, { text: 'You are helpful.' }],
      },
      toolConfig: {
        functionCallingConfig: {
          allowedFunctionNames: ['weather_lookup'],
          mode: 'ANY',
        },
      },
      tools: [
        {
          functionDeclarations: [
            {
              description: 'Lookup weather',
              name: 'weather_lookup',
              parameters: {
                properties: {
                  city: { type: 'STRING' },
                  nested: {
                    properties: {
                      count: { type: 'INTEGER' },
                    },
                    type: 'OBJECT',
                  },
                },
                required: ['city'],
                type: 'OBJECT',
              },
            },
          ],
        },
      ],
    });
    expect(request.contents).toEqual([
      {
        parts: [
          { text: 'Hello' },
          {
            inlineData: {
              data: 'abc123',
              mimeType: 'image/png',
            },
          },
        ],
        role: 'user',
      },
      {
        parts: [
          {
            functionCall: {
              args: { city: 'Berlin' },
              name: 'weather_lookup',
            },
          },
        ],
        role: 'model',
      },
      {
        parts: [
          {
            functionResponse: {
              name: 'weather_lookup',
              response: { temperature: 18 },
            },
          },
        ],
        role: 'user',
      },
    ]);
  });

  it('maps responseFormat to Gemini generationConfig response schema fields', () => {
    expect(
      translateGeminiRequest({
        messages: [{ content: 'Return an object.', role: 'user' }],
        model: 'gemini-2.5-flash',
        responseFormat: { type: 'json_object' },
      }),
    ).toMatchObject({
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    expect(
      translateGeminiRequest({
        messages: [{ content: 'Return the answer.', role: 'user' }],
        model: 'gemini-2.5-flash',
        responseFormat: {
          schema: {
            properties: {
              answer: { type: 'string' },
            },
            required: ['answer'],
            type: 'object',
          },
          type: 'json_schema',
        },
      }),
    ).toMatchObject({
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          properties: {
            answer: { type: 'STRING' },
          },
          required: ['answer'],
          type: 'OBJECT',
        },
      },
    });
  });

  it('uses Gemini 3.5 responseFormat envelope with enum mime type', () => {
    expect(
      translateGeminiRequest({
        maxTokens: 96,
        messages: [{ content: 'Return the answer.', role: 'user' }],
        model: 'gemini-3.5-flash',
        responseFormat: {
          schema: {
            properties: {
              answer: { type: 'string' },
            },
            required: ['answer'],
            type: 'object',
          },
          type: 'json_schema',
        },
      }),
    ).toMatchObject({
      generationConfig: {
        responseFormat: {
          text: {
            mimeType: 'APPLICATION_JSON',
            schema: {
              properties: {
                answer: { type: 'STRING' },
              },
              required: ['answer'],
              type: 'OBJECT',
            },
          },
        },
      },
    });
    expect(
      (
        translateGeminiRequest({
          maxTokens: 96,
          messages: [{ content: 'Return the answer.', role: 'user' }],
          model: 'gemini-3.5-flash',
          responseFormat: {
            schema: {
              properties: {
                answer: { type: 'string' },
              },
              type: 'object',
            },
            type: 'json_schema',
          },
        }).generationConfig as Record<string, unknown>
      ).maxOutputTokens,
    ).toBeUndefined();
  });

  it('maps Gemini tool choice aliases and schema bundles', () => {
    expect(translateGeminiToolChoice({ type: 'auto' })).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
    expect(
      translateGeminiTools([
        {
          description: 'Lookup weather',
          name: 'weather_lookup',
          parameters: {
            properties: {
              city: { enum: ['Berlin', 'Paris'], type: 'string' },
            },
            type: 'object',
          },
        },
      ]),
    ).toEqual({
      functionDeclarations: [
        {
          description: 'Lookup weather',
          name: 'weather_lookup',
          parameters: {
            properties: {
              city: {
                enum: ['Berlin', 'Paris'],
                type: 'STRING',
              },
            },
            type: 'OBJECT',
          },
        },
      ],
    });
  });

  it('rejects invalid and duplicate portable tool definitions', () => {
    const valid = {
      description: 'Lookup weather',
      name: 'weather_lookup',
      parameters: { type: 'object' as const },
    };
    expect(() =>
      translateGeminiTools([{ ...valid, name: 'weather.lookup' }]),
    ).toThrow(ProviderCapabilityError);
    expect(() => translateGeminiTools([valid, valid])).toThrow(
      ProviderCapabilityError,
    );
  });

  it('strips JSON Schema fields unsupported by Gemini function declarations', () => {
    expect(
      translateGeminiTools([
        {
          description: 'Lookup weather',
          name: 'weather_lookup',
          parameters: {
            additionalProperties: false,
            properties: {
              city: {
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                },
                type: 'object',
              },
            },
            type: 'object',
          },
        },
      ]),
    ).toEqual({
      functionDeclarations: [
        {
          description: 'Lookup weather',
          name: 'weather_lookup',
          parameters: {
            properties: {
              city: {
                properties: {
                  name: { type: 'STRING' },
                },
                type: 'OBJECT',
              },
            },
            type: 'OBJECT',
          },
        },
      ],
    });
  });

  it('maps Gemini cachedContent references into generateContent payloads', () => {
    const request = translateGeminiRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gemini-2.5-flash',
      providerOptions: {
        google: {
          promptCaching: {
            cachedContent: 'cachedContents/support-faq-v1',
          },
        },
      },
    });

    expect(request).toMatchObject({
      cachedContent: 'cachedContents/support-faq-v1',
    });
  });

  it('maps Gemini thinking options into generationConfig.thinkingConfig', () => {
    const request = translateGeminiRequest({
      maxTokens: 512,
      messages: [{ content: 'Think carefully.', role: 'user' }],
      model: 'gemini-3-pro',
      providerOptions: {
        google: {
          thinking: {
            includeThoughts: true,
            level: 'low',
          },
        },
      },
      temperature: 0,
    });

    expect(request).toMatchObject({
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0,
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: 'low',
        },
      },
    });
  });

  it('maps Gemini thinking budget into generationConfig.thinkingConfig', () => {
    const request = translateGeminiRequest({
      messages: [{ content: 'Think carefully.', role: 'user' }],
      model: 'gemini-2.5-flash',
      providerOptions: {
        google: {
          thinking: {
            budgetTokens: 0,
            includeThoughts: false,
          },
        },
      },
    });

    expect(request).toMatchObject({
      generationConfig: {
        thinkingConfig: {
          includeThoughts: false,
          thinkingBudget: 0,
        },
      },
    });
  });

  it.each(['gemini-3.6-flash', 'gemini-3.5-flash-lite'])(
    'omits deprecated sampling parameters for %s',
    (model) => {
      const request = translateGeminiRequest({
        maxTokens: 256,
        messages: [{ content: 'Hello', role: 'user' }],
        model,
        temperature: 0,
      });

      expect(request).toMatchObject({
        generationConfig: {
          maxOutputTokens: 256,
        },
      });
      expect(
        (request.generationConfig as Record<string, unknown>).temperature,
      ).toBeUndefined();
    },
  );

  it('translates Gemini embedding requests with task type, dimensions, and title', () => {
    const request = translateGeminiEmbeddingRequest(
      {
        dimensions: 768,
        model: 'gemini-embedding-2',
        providerOptions: {
          google: {
            taskInstruction: 'Embed this knowledge-base document.',
            title: 'Refund Policy',
          },
        },
        purpose: 'retrieval_document',
      },
      [
        { text: 'Refunds are available for 30 days.', type: 'text' },
        {
          data: 'cGRm',
          mediaType: 'application/pdf',
          type: 'document',
        },
      ],
    );

    expect(request).toEqual({
      content: {
        parts: [
          { text: 'Embed this knowledge-base document.' },
          { text: 'Refunds are available for 30 days.' },
          {
            inlineData: {
              data: 'cGRm',
              mimeType: 'application/pdf',
            },
          },
        ],
      },
      outputDimensionality: 768,
      taskType: 'RETRIEVAL_DOCUMENT',
      title: 'Refund Policy',
    });
  });

  it('translates Gemini embedding responses into canonical embedding payloads', () => {
    const response = translateGeminiEmbeddingResponse(
      {
        embedding: {
          values: [0.1, 0.2, 0.3],
        },
        usageMetadata: {
          promptTokenCount: 12,
        },
      },
      'gemini-embedding-2',
      new ModelRegistry(),
    );

    expect(response).toEqual({
      embeddings: [{ index: 0, values: [0.1, 0.2, 0.3] }],
      model: 'gemini-embedding-2',
      provider: 'google',
      raw: {
        embedding: {
          values: [0.1, 0.2, 0.3],
        },
        usageMetadata: {
          promptTokenCount: 12,
        },
      },
      usage: {
        cost: '$0.0000',
        costUSD: 0.0000024,
        inputTokens: 12,
      },
    });
  });

  it('rejects Gemini embedding tool parts', () => {
    expect(() =>
      translateGeminiEmbeddingRequest(
        {
          model: 'gemini-embedding-2',
        },
        [
          {
            args: { city: 'Berlin' },
            id: 'call_1',
            name: 'weather_lookup',
            type: 'tool_call',
          },
        ],
      ),
    ).toThrow(ProviderCapabilityError);
  });

  it.each([
    ['empty string', ''],
    ['empty array', []],
    ['null input', null],
    ['undefined input', undefined],
    ['mixed empty batch', ['valid', '']],
    ['mixed null batch', ['valid', null]],
    ['malformed part', [{ type: 'text' }]],
  ])(
    'rejects invalid direct embedding input before fetch: %s',
    async (_label, input) => {
      const fetchImplementation = vi.fn();
      const adapter = new GeminiAdapter({
        apiKey: 'gemini-key',
        fetchImplementation,
      });

      await expect(
        adapter.embed({
          input,
          model: 'gemini-embedding-2',
        } as never),
      ).rejects.toMatchObject({
        details: { option: 'input' },
        name: 'ProviderCapabilityError',
        statusCode: 400,
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([127, 3073, 0, -1, 1.5, Number.NaN, Infinity, -Infinity])(
    'rejects direct embedding dimensions %s before fetch',
    async (dimensions) => {
      const fetchImplementation = vi.fn();
      const adapter = new GeminiAdapter({
        apiKey: 'gemini-key',
        fetchImplementation,
      });

      await expect(
        adapter.embed({
          dimensions,
          input: 'valid',
          model: 'gemini-embedding-2',
        }),
      ).rejects.toMatchObject({
        details: { option: 'dimensions' },
        name: 'ProviderCapabilityError',
        statusCode: 400,
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([127, 3073, 0, -1, 1.5, Number.NaN, Infinity, -Infinity])(
    'rejects translator embedding dimensions %s',
    (dimensions) => {
      expect(() =>
        translateGeminiEmbeddingRequest(
          { dimensions, model: 'gemini-embedding-2' },
          'valid',
        ),
      ).toThrow(ProviderCapabilityError);
    },
  );

  it.each([128, 512, 768, 1024, 1536, 3072])(
    'accepts translator embedding dimensions %s',
    (dimensions) => {
      expect(
        translateGeminiEmbeddingRequest(
          { dimensions, model: 'gemini-embedding-2' },
          'valid',
        ),
      ).toMatchObject({ outputDimensionality: dimensions });
    },
  );

  it.each([
    '',
    null,
    undefined,
    [],
    [{ text: ' ', type: 'text' }],
    [{ type: 'unknown' }],
  ])('rejects invalid translator embedding input %#', (input) => {
    expect(() =>
      translateGeminiEmbeddingRequest(
        { model: 'gemini-embedding-2' },
        input as never,
      ),
    ).toThrow(ProviderCapabilityError);
  });

  it('rejects invalid purposes in the direct adapter and public translator', async () => {
    const fetchImplementation = vi.fn();
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation,
    });

    await expect(
      adapter.embed({
        input: 'valid',
        model: 'gemini-embedding-2',
        purpose: 'unknown',
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

    expect(() =>
      translateGeminiEmbeddingRequest(
        {
          dimensions: 0,
          model: 'gemini-embedding-2',
          purpose: 'unknown',
        } as never,
        'valid',
      ),
    ).toThrow(ProviderCapabilityError);
  });

  it.each([
    ['retrieval_document', 'RETRIEVAL_DOCUMENT'],
    ['retrieval_query', 'RETRIEVAL_QUERY'],
    ['semantic_similarity', 'SEMANTIC_SIMILARITY'],
    ['classification', 'CLASSIFICATION'],
    ['clustering', 'CLUSTERING'],
  ] as const)('maps embedding purpose %s to %s', (purpose, taskType) => {
    expect(
      translateGeminiEmbeddingRequest(
        {
          model: 'gemini-embedding-2',
          purpose,
        },
        'valid',
      ),
    ).toMatchObject({ taskType });
  });

  it('translates Gemini cache creation payloads', () => {
    const request = translateGeminiCacheCreateRequest({
      displayName: 'Support FAQ',
      messages: [{ content: 'FAQ body', role: 'user' }],
      model: 'gemini-2.5-flash',
      system: 'Be concise.',
      toolChoice: { type: 'auto' },
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
      ttl: '600s',
    });

    expect(request).toMatchObject({
      contents: [{ parts: [{ text: 'FAQ body' }], role: 'user' }],
      displayName: 'Support FAQ',
      model: 'models/gemini-2.5-flash',
      systemInstruction: {
        parts: [{ text: 'Be concise.' }],
      },
      toolConfig: {
        functionCallingConfig: {
          mode: 'AUTO',
        },
      },
      tools: [
        {
          functionDeclarations: [
            expect.objectContaining({ name: 'weather_lookup' }),
          ],
        },
      ],
      ttl: '600s',
    });
  });

  it('translates Gemini cache update payloads', () => {
    expect(
      translateGeminiCacheUpdateRequest({
        ttl: '1200s',
      }),
    ).toEqual({
      body: { ttl: '1200s' },
      updateMask: 'ttl',
    });

    expect(
      translateGeminiCacheUpdateRequest({
        expireTime: '2026-04-21T12:00:00Z',
      }),
    ).toEqual({
      body: { expireTime: '2026-04-21T12:00:00Z' },
      updateMask: 'expireTime',
    });

    expect(() =>
      translateGeminiCacheUpdateRequest({
        expireTime: '2026-04-21T12:00:00Z',
        ttl: '1200s',
      }),
    ).toThrow(ProviderError);

    expect(() => translateGeminiCacheUpdateRequest({})).toThrow(ProviderError);
  });

  it('translates multimodal inputs and primitive tool results', () => {
    const request = translateGeminiRequest({
      messages: [
        {
          content: [
            {
              mediaType: 'audio/wav',
              type: 'audio',
              url: 'https://example.com/audio.wav',
            },
            {
              data: 'pdf-data',
              mediaType: 'application/pdf',
              type: 'document',
            },
            { type: 'image_url', url: 'https://example.com/cat.jpg' },
          ],
          role: 'user',
        },
        {
          content: [
            {
              isError: true,
              result: 'boom',
              toolCallId: 'call_1',
              type: 'tool_result',
            },
          ],
          role: 'user',
        },
      ],
      model: 'gemini-2.5-flash',
      toolChoice: { type: 'none' },
    });

    expect(request).toMatchObject({
      contents: [
        {
          parts: [
            {
              fileData: {
                fileUri: 'https://example.com/audio.wav',
                mimeType: 'audio/wav',
              },
            },
            {
              inlineData: {
                data: 'pdf-data',
                mimeType: 'application/pdf',
              },
            },
            {
              fileData: {
                fileUri: 'https://example.com/cat.jpg',
                mimeType: 'image/jpeg',
              },
            },
          ],
          role: 'user',
        },
        {
          parts: [
            {
              functionResponse: {
                name: 'call_1',
                response: {
                  isError: true,
                  result: 'boom',
                },
              },
            },
          ],
          role: 'user',
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: 'NONE',
        },
      },
    });
  });

  it('translates Gemini responses into canonical responses', () => {
    const response = translateGeminiResponse(
      {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Checking.' },
                {
                  functionCall: {
                    args: { city: 'Berlin' },
                    name: 'weather_lookup',
                  },
                },
              ],
              role: 'model',
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          cachedContentTokenCount: 5,
          candidatesTokenCount: 12,
          promptTokenCount: 30,
          thoughtsTokenCount: 7,
        },
      },
      'gemini-2.5-flash',
    );

    expect(response).toMatchObject({
      finishReason: 'tool_call',
      model: 'gemini-2.5-flash',
      provider: 'google',
      text: 'Checking.',
      toolCalls: [
        {
          args: { city: 'Berlin' },
          id: 'gemini_tool_0_1_weather_lookup',
          name: 'weather_lookup',
        },
      ],
      usage: {
        cachedTokens: 5,
        inputTokens: 30,
        outputTokens: 12,
        reasoningTokens: 7,
      },
    });
  });

  it('keeps thought parts private while preserving raw signatures and reasoning usage', () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'SECRET_INTERNAL_THOUGHT',
                thought: true,
                thoughtSignature: 'signature-123',
              },
              { text: 'Visible answer.' },
            ],
            role: 'model' as const,
          },
          finishReason: 'STOP' as const,
          index: 0,
        },
      ],
      usageMetadata: {
        candidatesTokenCount: 3,
        promptTokenCount: 4,
        thoughtsTokenCount: 9,
      },
    };

    const response = translateGeminiResponse(payload, 'gemini-2.5-flash');

    expect(response.text).toBe('Visible answer.');
    expect(response.content).toEqual([
      { text: 'Visible answer.', type: 'text' },
    ]);
    expect(response.raw).toBe(payload);
    expect(
      (response.raw as typeof payload).candidates[0]?.content.parts[0],
    ).toMatchObject({ thoughtSignature: 'signature-123' });
    expect(response.usage.reasoningTokens).toBe(9);
    expect(JSON.stringify(response.content)).not.toContain(
      'SECRET_INTERNAL_THOUGHT',
    );
  });

  it('rejects exported translation of thought-only terminal responses', () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'SECRET_TRANSLATED_THOUGHT',
                thought: true,
                thoughtSignature: 'translated-secret-signature',
              },
            ],
          },
          finishReason: 'STOP' as const,
          index: 0,
        },
      ],
    };

    const error = (() => {
      try {
        translateGeminiResponse(payload, 'gemini-2.5-flash');
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      details: {
        code: 'invalid_provider_response',
        operation: 'complete',
        path: 'candidates[0].content.parts',
        phase: 'schema',
        reason: 'invalid_provider_response',
      },
      provider: 'google',
      retryable: false,
      statusCode: 502,
    });
    expect(JSON.stringify(error)).not.toContain('SECRET_TRANSLATED_THOUGHT');
    expect(JSON.stringify(error)).not.toContain('translated-secret-signature');
  });

  it('accepts mixed private-thought and tool output without exposing the thought', () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'SECRET_TOOL_THOUGHT',
                thought: true,
                thoughtSignature: 'tool-secret-signature',
              },
              {
                functionCall: {
                  args: { city: 'Paris' },
                  name: 'weather_lookup',
                },
              },
            ],
          },
          finishReason: 'STOP' as const,
          index: 0,
        },
      ],
      usageMetadata: { thoughtsTokenCount: 6 },
    };

    const response = translateGeminiResponse(payload, 'gemini-2.5-flash');

    expect(response.text).toBe('');
    expect(response.toolCalls).toEqual([
      {
        args: { city: 'Paris' },
        id: 'gemini_tool_0_1_weather_lookup',
        name: 'weather_lookup',
      },
    ]);
    expect(response.raw).toBe(payload);
    expect(response.usage.reasoningTokens).toBe(6);
    expect(JSON.stringify(response.content)).not.toContain(
      'SECRET_TOOL_THOUGHT',
    );
    expect(JSON.stringify(response.content)).not.toContain(
      'tool-secret-signature',
    );
  });

  it('privately replays exact signed Gemini content and native function ids', () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'PRIVATE_THOUGHT',
                thought: true,
                thoughtSignature: 'cHJpdmF0ZS10aG91Z2h0',
              },
              {
                functionCall: {
                  args: { city: 'Paris' },
                  id: 'native-call-1',
                  name: 'weather_lookup',
                },
                thoughtSignature: 'ZnVuY3Rpb24tY2FsbA==',
              },
            ],
          },
          finishReason: 'STOP' as const,
          index: 0,
        },
      ],
    };
    const response = translateGeminiResponse(payload, 'gemini-2.5-flash');
    const assistant = {
      content: response.content,
      role: 'assistant' as const,
    };
    copyGoogleReplayState(response, assistant);
    const request = translateGeminiRequest({
      maxTokens: 32,
      messages: [
        { content: 'weather?', role: 'user' },
        assistant,
        {
          content: [
            {
              name: 'weather_lookup',
              result: { temperature: 18 },
              toolCallId: response.toolCalls[0]!.id,
              type: 'tool_result' as const,
            },
          ],
          role: 'user',
        },
      ],
      model: 'gemini-2.5-flash',
    });

    expect((request.contents as Array<{ parts: unknown[] }>)[1]!.parts).toEqual(
      payload.candidates[0]!.content.parts,
    );
    expect((request.contents as Array<{ parts: unknown[] }>)[2]!.parts).toEqual(
      [
        {
          functionResponse: {
            id: 'native-call-1',
            name: 'weather_lookup',
            response: { temperature: 18 },
          },
        },
      ],
    );
    expect(JSON.stringify(response.content)).not.toContain('PRIVATE_THOUGHT');
    expect(JSON.stringify(response.content)).not.toContain('thoughtSignature');
    const crossModelRequest = translateGeminiRequest({
      messages: [{ content: 'weather?', role: 'user' }, assistant],
      model: 'gemini-3.1-flash-lite',
    });
    expect(JSON.stringify(crossModelRequest)).not.toContain(
      'cHJpdmF0ZS10aG91Z2h0',
    );
    expect(JSON.stringify(crossModelRequest)).not.toContain(
      'ZnVuY3Rpb24tY2FsbA==',
    );
  });

  it('preserves ordered parallel calls without copying the first signature', () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { args: { value: 1 }, name: 'same_tool' },
                thoughtSignature: 'Zmlyc3Qtb25seQ==',
              },
              { functionCall: { args: { value: 1 }, name: 'same_tool' } },
            ],
          },
          finishReason: 'STOP' as const,
          index: 0,
        },
      ],
    };
    const response = translateGeminiResponse(payload, 'gemini-2.5-flash');
    const assistant = {
      content: response.content,
      role: 'assistant' as const,
    };
    copyGoogleReplayState(response, assistant);
    const request = translateGeminiRequest({
      messages: [{ content: 'go', role: 'user' }, assistant],
      model: 'gemini-2.5-flash',
    });

    expect(response.toolCalls.map((call) => call.id)).toEqual([
      'gemini_tool_0_0_same_tool',
      'gemini_tool_0_1_same_tool',
    ]);
    expect((request.contents as Array<{ parts: unknown[] }>)[1]!.parts).toEqual(
      payload.candidates[0]!.content.parts,
    );
  });

  it('returns content_filter for blocked responses without candidates', () => {
    const response = translateGeminiResponse(
      {
        promptFeedback: {
          blockReason: 'SAFETY',
        },
        usageMetadata: {
          candidatesTokenCount: 0,
          promptTokenCount: 15,
        },
      },
      'gemini-2.5-flash',
    );

    expect(response.finishReason).toBe('content_filter');
    expect(response.text).toBe('');
    expect(response.toolCalls).toEqual([]);
  });

  it('normalizes additional Gemini finish reasons', () => {
    expect(
      translateGeminiResponse(
        {
          candidates: [
            {
              content: {
                parts: [{ text: 'Truncated' }],
                role: 'model',
              },
              finishReason: 'MAX_TOKENS',
              index: 0,
            },
          ],
        },
        'gemini-2.5-flash',
      ).finishReason,
    ).toBe('length');

    expect(
      translateGeminiResponse(
        {
          candidates: [
            {
              content: {
                parts: [{ text: 'Blocked' }],
                role: 'model',
              },
              finishReason: 'SAFETY',
              index: 0,
            },
          ],
        },
        'gemini-2.5-flash',
      ).finishReason,
    ).toBe('content_filter');

    expect(
      translateGeminiResponse(
        {
          candidates: [
            {
              content: {
                parts: [{ text: 'Weird' }],
                role: 'model',
              },
              finishReason: 'OTHER',
              index: 0,
            },
          ],
        },
        'gemini-2.5-flash',
      ).finishReason,
    ).toBe('error');

    expect(
      translateGeminiResponse(
        {
          candidates: [
            {
              content: {
                parts: [{ text: 'No reason yet' }],
                role: 'model',
              },
              finishReason: null,
              index: 0,
            },
          ],
        },
        'gemini-2.5-flash',
      ).finishReason,
    ).toBe('stop');
  });

  it('throws if a response has no candidates and no block reason', () => {
    const error = (() => {
      try {
        translateGeminiResponse(
          {
            usageMetadata: {
              candidatesTokenCount: 0,
              promptTokenCount: 15,
            },
          },
          'gemini-2.5-flash',
        );
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      details: {
        code: 'invalid_provider_response',
        operation: 'complete',
        path: 'candidates',
        phase: 'schema',
        reason: 'invalid_provider_response',
      },
      provider: 'google',
      retryable: false,
      statusCode: 502,
    });
  });

  it('maps Gemini API errors into typed errors', async () => {
    const authError = await mapGeminiError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Bad key',
            status: 'UNAUTHENTICATED',
          },
        }),
        {
          headers: { 'x-goog-request-id': 'req_auth' },
          status: 401,
        },
      ),
      'gemini-2.5-flash',
    );
    const contextError = await mapGeminiError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Prompt exceeds the context window',
            status: 'INVALID_ARGUMENT',
          },
        }),
        {
          status: 400,
        },
      ),
      'gemini-2.5-flash',
    );
    const rateLimitError = await mapGeminiError(
      new Response(
        JSON.stringify({
          error: {
            details: [{ retryDelay: '2s' }],
            message: 'Slow down',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        {
          status: 429,
        },
      ),
      'gemini-2.5-flash',
    );

    expect(authError).toBeInstanceOf(AuthenticationError);
    expect(authError.requestId).toBe('req_auth');
    expect(contextError).toBeInstanceOf(ContextLimitError);
    expect(rateLimitError).toBeInstanceOf(RateLimitError);
    expect(rateLimitError.details).toEqual({
      errorDetails: [{ retryDelay: '2s' }],
    });
  });

  it('does not misclassify signature, generic, or unrelated token errors as context limits', async () => {
    const errors = await Promise.all(
      [
        'Function call is missing thought_signature value ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
        'Request contained an unsupported field',
        'The token parameter has an invalid type',
      ].map((message) =>
        mapGeminiError(
          new Response(
            JSON.stringify({ error: { message, status: 'INVALID_ARGUMENT' } }),
            { status: 400 },
          ),
          'gemini-3.1-flash-lite',
        ),
      ),
    );

    for (const error of errors) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(ContextLimitError);
      expect(error.retryable).toBe(false);
    }
    expect(errors[0]!.message).toContain('[REDACTED]');
    expect(errors[0]!.message).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it.each([
    'Token count exceeds the maximum number of tokens allowed.',
    'The input token count exceeds the maximum number of tokens allowed.',
  ])(
    'maps Gemini context-limit form %j to ContextLimitError',
    async (message) => {
      const error = await mapGeminiError(
        new Response(
          JSON.stringify({ error: { message, status: 'INVALID_ARGUMENT' } }),
          { status: 400 },
        ),
        'gemini-3.1-flash-lite',
      );

      expect(error).toBeInstanceOf(ContextLimitError);
      expect(error.retryable).toBe(false);
    },
  );

  it('maps generic provider errors on invalid JSON bodies', async () => {
    const providerError = await mapGeminiError(
      new Response('not-json', {
        status: 500,
      }),
      undefined,
    );

    expect(providerError).toBeInstanceOf(ProviderError);
  });

  it('maps permission and generic provider errors', async () => {
    const authError = await mapGeminiError(
      new Response(
        JSON.stringify({
          error: {
            message: 'No access',
            status: 'PERMISSION_DENIED',
          },
        }),
        {
          status: 403,
        },
      ),
      'gemini-2.5-flash',
    );
    const providerError = await mapGeminiError(
      new Response(
        JSON.stringify({
          error: {
            message: 'Backend unavailable',
            status: 'UNAVAILABLE',
          },
        }),
        {
          status: 503,
        },
      ),
      'gemini-2.5-flash',
    );

    expect(authError).toBeInstanceOf(AuthenticationError);
    expect(providerError).toBeInstanceOf(ProviderError);
  });

  it('performs a complete Gemini request with auth headers', async () => {
    const signal = new AbortController().signal;
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Hello there' }],
                  role: 'model',
                },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: {
              candidatesTokenCount: 10,
              promptTokenCount: 20,
            },
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        ),
    );
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation,
    });

    const result = await adapter.complete({
      maxTokens: 128,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gemini-2.5-flash',
      signal,
    });
    const request = fetchImplementation.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = request[1].headers as Record<string, string>;

    expect(result.text).toBe('Hello there');
    expect(request[0]).toContain(
      '/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(headers['x-goog-api-key']).toBe('gemini-key');
    expect(request[1].signal).toBe(signal);
  });

  it('streams text chunks and done events', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            makeSSEStream([
              {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Hello ' }],
                      role: 'model',
                    },
                    finishReason: null,
                    index: 0,
                  },
                ],
                usageMetadata: {
                  candidatesTokenCount: 3,
                  promptTokenCount: 20,
                },
              },
              {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'world' }],
                      role: 'model',
                    },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: {
                  candidatesTokenCount: 12,
                  promptTokenCount: 20,
                },
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
      model: 'gemini-2.5-flash',
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

  it('emits opted-in thoughts only as closed reasoning events', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi.fn(async () =>
        Promise.resolve(
          new Response(
            makeSSEStream([
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: 'SECRET_REASONING',
                          thought: true,
                          thoughtSignature: 'sig',
                        },
                      ],
                    },
                    finishReason: null,
                    index: 0,
                  },
                ],
              },
              {
                candidates: [
                  {
                    content: { parts: [{ text: 'Visible' }] },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
              },
            ]),
            {
              headers: { 'content-type': 'text/event-stream' },
              status: 200,
            },
          ),
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      maxTokens: 32,
      messages: [{ content: 'hello', role: 'user' }],
      model: 'gemini-2.5-flash',
      providerOptions: {
        google: { thinking: { includeThoughts: true } },
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.slice(0, 4)).toEqual([
      { type: 'reasoning-start' },
      { delta: 'SECRET_REASONING', type: 'reasoning-delta' },
      { type: 'reasoning-end' },
      { delta: 'Visible', type: 'text-delta' },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => ('delta' in chunk ? chunk.delta : ''))
        .join(''),
    ).toBe('Visible');
  });

  it('keeps streamed thought parts private by default', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi.fn(async () =>
        Promise.resolve(
          new Response(
            makeSSEStream([
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: 'SECRET_DEFAULT_REASONING',
                          thought: true,
                          thoughtSignature: 'private-signature',
                        },
                      ],
                    },
                    finishReason: null,
                    index: 0,
                  },
                ],
              },
              {
                candidates: [
                  {
                    content: { parts: [{ text: 'Visible answer' }] },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: {
                  candidatesTokenCount: 2,
                  promptTokenCount: 1,
                  thoughtsTokenCount: 5,
                },
              },
            ]),
            {
              headers: { 'content-type': 'text/event-stream' },
              status: 200,
            },
          ),
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      maxTokens: 32,
      messages: [{ content: 'hello', role: 'user' }],
      model: 'gemini-2.5-flash',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual({
      delta: 'Visible answer',
      type: 'text-delta',
    });
    expect(chunks.some((chunk) => chunk.type.startsWith('reasoning-'))).toBe(
      false,
    );
    expect(JSON.stringify(chunks)).not.toContain('SECRET_DEFAULT_REASONING');
    expect(JSON.stringify(chunks)).not.toContain('private-signature');
    expect(chunks.at(-1)).toMatchObject({
      type: 'done',
      usage: { reasoningTokens: 5 },
    });
  });

  it('accepts thought-only terminal streams when thoughts are explicitly emitted', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi.fn(async () =>
        Promise.resolve(
          new Response(
            makeSSEStream([
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: 'Opted-in reasoning',
                          thought: true,
                          thoughtSignature: 'private-reasoning-signature',
                        },
                      ],
                    },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 1,
                  thoughtsTokenCount: 7,
                },
              },
            ]),
            {
              headers: { 'content-type': 'text/event-stream' },
              status: 200,
            },
          ),
        ),
      ),
    });

    const chunks = [];
    for await (const chunk of adapter.stream({
      maxTokens: 32,
      messages: [{ content: 'hello', role: 'user' }],
      model: 'gemini-2.5-flash',
      providerOptions: {
        google: { thinking: { includeThoughts: true } },
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'reasoning-start' },
      { delta: 'Opted-in reasoning', type: 'reasoning-delta' },
      { type: 'reasoning-end' },
      expect.objectContaining({
        type: 'done',
        usage: expect.objectContaining({ reasoningTokens: 7 }),
      }),
    ]);
    expect(JSON.stringify(chunks)).not.toContain('private-reasoning-signature');
  });

  it('streams mixed private-thought and functionCall chunks', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            makeSSEStream([
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: 'SECRET_STREAM_TOOL_THOUGHT',
                          thought: true,
                          thoughtSignature: 'stream-tool-secret-signature',
                        },
                        {
                          functionCall: {
                            args: { city: 'Berlin' },
                            name: 'weather_lookup',
                          },
                        },
                      ],
                      role: 'model',
                    },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: {
                  candidatesTokenCount: 8,
                  promptTokenCount: 20,
                },
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
      model: 'gemini-2.5-flash',
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
      {
        id: 'gemini_tool_0_1_weather_lookup',
        name: 'weather_lookup',
        type: 'tool-call-start',
      },
      {
        id: 'gemini_tool_0_1_weather_lookup',
        name: 'weather_lookup',
        args: { city: 'Berlin' },
        type: 'tool-call-arguments',
      },
      expect.objectContaining({
        finishReason: 'tool_call',
        type: 'done',
      }),
    ]);
    expect(JSON.stringify(chunks)).not.toContain('SECRET_STREAM_TOOL_THOUGHT');
    expect(JSON.stringify(chunks)).not.toContain(
      'stream-tool-secret-signature',
    );
  });

  it('merges a late streamed signature without duplicating the visible call', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            makeSSEStream([
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            args: { city: 'Berlin' },
                            name: 'weather_lookup',
                          },
                        },
                      ],
                    },
                    finishReason: null,
                    index: 0,
                  },
                ],
              },
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            args: { city: 'Berlin' },
                            name: 'weather_lookup',
                          },
                          thoughtSignature: 'bGF0ZS1zaWduYXR1cmU=',
                        },
                      ],
                    },
                    finishReason: null,
                    index: 0,
                  },
                ],
              },
              {
                candidates: [
                  {
                    content: { parts: [] },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 3 },
              },
            ]),
            { headers: { 'content-type': 'text/event-stream' }, status: 200 },
          ),
      ),
    });
    const chunks = [];
    for await (const chunk of adapter.stream({
      messages: [{ content: 'weather?', role: 'user' }],
      model: 'gemini-2.5-flash',
    })) {
      chunks.push(chunk);
    }
    expect(
      chunks.filter((chunk) => chunk.type === 'tool-call-start'),
    ).toHaveLength(1);
    const done = chunks.find((chunk) => chunk.type === 'done')!;
    const assistant = {
      content: [
        {
          args: { city: 'Berlin' },
          id: 'gemini_tool_0_0_weather_lookup',
          name: 'weather_lookup',
          type: 'tool_call' as const,
        },
      ],
      role: 'assistant' as const,
    };
    copyGoogleReplayState(done, assistant);
    const request = translateGeminiRequest({
      messages: [{ content: 'weather?', role: 'user' }, assistant],
      model: 'gemini-2.5-flash',
    });
    expect((request.contents as Array<{ parts: unknown[] }>)[1]!.parts).toEqual(
      [
        {
          functionCall: { args: { city: 'Berlin' }, name: 'weather_lookup' },
          thoughtSignature: 'bGF0ZS1zaWduYXR1cmU=',
        },
      ],
    );
    expect(JSON.stringify(chunks)).not.toContain('bGF0ZS1zaWduYXR1cmU=');
  });

  it('deduplicates repeated streamed functionCall chunks and preserves blocked finish state', async () => {
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi.fn(
        async () =>
          new Response(
            makeSSEStream([
              {
                promptFeedback: {
                  blockReason: 'SAFETY',
                },
              },
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            args: { city: 'Berlin' },
                            name: 'weather_lookup',
                          },
                        },
                      ],
                      role: 'model',
                    },
                    finishReason: null,
                    index: 0,
                  },
                ],
              },
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            args: { city: 'Berlin' },
                            name: 'weather_lookup',
                          },
                        },
                      ],
                      role: 'model',
                    },
                    finishReason: 'STOP',
                    index: 0,
                  },
                ],
                usageMetadata: {
                  candidatesTokenCount: 8,
                  promptTokenCount: 20,
                },
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
      model: 'gemini-2.5-flash',
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
      {
        id: 'gemini_tool_0_0_weather_lookup',
        name: 'weather_lookup',
        type: 'tool-call-start',
      },
      {
        id: 'gemini_tool_0_0_weather_lookup',
        name: 'weather_lookup',
        args: { city: 'Berlin' },
        type: 'tool-call-arguments',
      },
      expect.objectContaining({
        finishReason: 'tool_call',
        type: 'done',
      }),
    ]);
  });

  it('rejects unsupported structures and missing stream bodies before or during fetch', async () => {
    expect(() =>
      translateGeminiRequest({
        messages: [
          {
            content: [
              { type: 'image_url', url: 'https://example.com/image.png' },
            ],
            role: 'system',
          },
        ],
        model: 'gemini-2.5-flash',
      }),
    ).toThrow(ProviderCapabilityError);

    expect(() =>
      translateGeminiRequest({
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
        model: 'gemini-2.5-flash',
      }),
    ).toThrow(ProviderCapabilityError);

    expect(() =>
      translateGeminiRequest({
        messages: [
          {
            content: [{ mediaType: 'audio/wav', type: 'audio' }],
            role: 'user',
          },
        ],
        model: 'gemini-2.5-flash',
      }),
    ).toThrow('Gemini audio parts require data or a URL.');

    expect(() =>
      translateGeminiRequest({
        messages: [
          {
            content: [
              {
                result: { ok: false },
                toolCallId: 'call_1',
                type: 'tool_result',
              },
            ],
            role: 'assistant',
          },
        ],
        model: 'gemini-2.5-flash',
      }),
    ).toThrow(ProviderCapabilityError);

    const registry = new ModelRegistry();
    registry.register({
      contextWindow: 32000,
      id: 'mock-gemini-no-capabilities',
      inputPrice: 1,
      kind: 'completion',
      lastUpdated: '2026-04-15',
      outputPrice: 2,
      provider: 'google',
      supportsStreaming: false,
      supportsTools: false,
      supportsVision: false,
    });
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation,
      modelRegistry: registry,
    });

    await expect(
      adapter.complete({
        messages: [
          {
            content: [
              { type: 'image_url', url: 'https://example.com/image.png' },
            ],
            role: 'user',
          },
        ],
        model: 'mock-gemini-no-capabilities',
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    await expect(
      adapter.complete({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'mock-gemini-no-capabilities',
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
      adapter
        .stream({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'mock-gemini-no-capabilities',
        })
        .next(),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);

    const streamAdapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation: vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response(null, { status: 200 })),
    });

    await expect(
      streamAdapter
        .stream({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'gemini-2.5-flash',
        })
        .next(),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('supports Gemini cache lifecycle requests', async () => {
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            displayName: 'Support FAQ',
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
            displayName: 'Support FAQ',
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
            cachedContents: [
              {
                model: 'models/gemini-2.5-flash',
                name: 'cachedContents/cache_1',
              },
            ],
            nextPageToken: 'next-token',
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
            expireTime: '2026-04-21T12:00:00Z',
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
        new Response('{}', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation,
    });

    const created = await adapter.createCache({
      displayName: 'Support FAQ',
      messages: [{ content: 'FAQ body', role: 'user' }],
      model: 'gemini-2.5-flash',
      ttl: '600s',
    });
    const fetched = await adapter.getCache('cache_1');
    const listed = await adapter.listCaches({
      pageSize: 10,
      pageToken: 'cursor-1',
    });
    const updated = await adapter.updateCache('cache_1', {
      expireTime: '2026-04-21T12:00:00Z',
    });
    await adapter.deleteCache('cache_1');

    expect(created.name).toBe('cachedContents/cache_1');
    expect(fetched.name).toBe('cachedContents/cache_1');
    expect(listed.nextPageToken).toBe('next-token');
    expect(updated.expireTime).toBe('2026-04-21T12:00:00Z');

    const createRequest = fetchImplementation.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const getRequest = fetchImplementation.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    const listRequest = fetchImplementation.mock.calls[2] as unknown as [
      string,
      RequestInit,
    ];
    const updateRequest = fetchImplementation.mock.calls[3] as unknown as [
      string,
      RequestInit,
    ];
    const deleteRequest = fetchImplementation.mock.calls[4] as unknown as [
      string,
      RequestInit,
    ];

    expect(createRequest[0]).toContain('/v1beta/cachedContents');
    expect(JSON.parse(String(createRequest[1].body))).toMatchObject({
      model: 'models/gemini-2.5-flash',
      ttl: '600s',
    });
    expect(getRequest[0]).toContain('/v1beta/cachedContents/cache_1');
    expect(listRequest[0]).toContain(
      '/v1beta/cachedContents?pageSize=10&pageToken=cursor-1',
    );
    expect(updateRequest[0]).toContain(
      '/v1beta/cachedContents/cache_1?updateMask=expireTime',
    );
    expect(JSON.parse(String(updateRequest[1].body))).toEqual({
      expireTime: '2026-04-21T12:00:00Z',
    });
    expect(deleteRequest[0]).toContain('/v1beta/cachedContents/cache_1');
  });

  it('rejects cache names that could alter the authenticated request path', async () => {
    const fetchImplementation = vi.fn<() => Promise<Response>>();
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation,
    });

    const malicious = [
      '../models/gemini-pro:generateContent',
      'cachedContents/../models/gemini-pro:generateContent',
      'cache_1?alt=media',
      'cache_1/../../secret',
      'cache 1',
      'cachedContents/',
    ];

    for (const name of malicious) {
      await expect(adapter.getCache(name)).rejects.toThrow(
        /Invalid Gemini cache name/,
      );
      await expect(
        adapter.updateCache(name, { expireTime: '2026-04-21T12:00:00Z' }),
      ).rejects.toThrow(/Invalid Gemini cache name/);
      await expect(adapter.deleteCache(name)).rejects.toThrow(
        /Invalid Gemini cache name/,
      );
    }

    // No network call should ever be attempted for an invalid name.
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('accepts valid cache names with or without the resource prefix', async () => {
    const fetchImplementation = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              model: 'models/gemini-2.5-flash',
              name: 'cachedContents/cache_1',
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          ),
      );
    const adapter = new GeminiAdapter({
      apiKey: 'gemini-key',
      fetchImplementation,
    });

    await adapter.getCache('cache_1');
    await adapter.getCache('cachedContents/cache_1');

    const calls = fetchImplementation.mock.calls as unknown as [string][];
    expect(calls[0]?.[0]).toContain('/v1beta/cachedContents/cache_1');
    expect(calls[1]?.[0]).toContain('/v1beta/cachedContents/cache_1');
  });
});

function makeSSEStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });
}
