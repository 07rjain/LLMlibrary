import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ContextLimitError, ProviderCapabilityError, ProviderError, RateLimitError, } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import { GeminiAdapter, translateGeminiEmbeddingRequest, translateGeminiEmbeddingResponse, mapGeminiError, translateGeminiCacheCreateRequest, translateGeminiCacheUpdateRequest, translateGeminiRequest, translateGeminiResponse, translateGeminiToolChoice, translateGeminiTools, } from '../src/providers/gemini.js';
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
    it('maps Gemini tool choice aliases and schema bundles', () => {
        expect(translateGeminiToolChoice({ type: 'auto' })).toEqual({
            functionCallingConfig: { mode: 'AUTO' },
        });
        expect(translateGeminiTools([
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
        ])).toEqual({
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
    it('translates Gemini embedding requests with task type, dimensions, and title', () => {
        const request = translateGeminiEmbeddingRequest({
            dimensions: 768,
            model: 'gemini-embedding-2',
            providerOptions: {
                google: {
                    taskInstruction: 'Embed this knowledge-base document.',
                    title: 'Refund Policy',
                },
            },
            purpose: 'retrieval_document',
        }, [
            { text: 'Refunds are available for 30 days.', type: 'text' },
            {
                data: 'cGRm',
                mediaType: 'application/pdf',
                type: 'document',
            },
        ]);
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
        const response = translateGeminiEmbeddingResponse({
            embedding: {
                values: [0.1, 0.2, 0.3],
            },
            usageMetadata: {
                promptTokenCount: 12,
            },
        }, 'gemini-embedding-2', new ModelRegistry());
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
                inputTokens: 12,
            },
        });
    });
    it('rejects Gemini embedding tool parts', () => {
        expect(() => translateGeminiEmbeddingRequest({
            model: 'gemini-embedding-2',
        }, [
            {
                args: { city: 'Berlin' },
                id: 'call_1',
                name: 'weather_lookup',
                type: 'tool_call',
            },
        ])).toThrow(ProviderCapabilityError);
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
        expect(translateGeminiCacheUpdateRequest({
            ttl: '1200s',
        })).toEqual({
            body: { ttl: '1200s' },
            updateMask: 'ttl',
        });
        expect(translateGeminiCacheUpdateRequest({
            expireTime: '2026-04-21T12:00:00Z',
        })).toEqual({
            body: { expireTime: '2026-04-21T12:00:00Z' },
            updateMask: 'expireTime',
        });
        expect(() => translateGeminiCacheUpdateRequest({
            expireTime: '2026-04-21T12:00:00Z',
            ttl: '1200s',
        })).toThrow(ProviderError);
        expect(() => translateGeminiCacheUpdateRequest({})).toThrow(ProviderError);
    });
    it('translates multimodal inputs and primitive tool results', () => {
        const request = translateGeminiRequest({
            messages: [
                {
                    content: [
                        { mediaType: 'audio/wav', type: 'audio', url: 'https://example.com/audio.wav' },
                        { data: 'pdf-data', mediaType: 'application/pdf', type: 'document' },
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
        const response = translateGeminiResponse({
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
            },
        }, 'gemini-2.5-flash');
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
            },
        });
    });
    it('returns content_filter for blocked responses without candidates', () => {
        const response = translateGeminiResponse({
            promptFeedback: {
                blockReason: 'SAFETY',
            },
            usageMetadata: {
                candidatesTokenCount: 0,
                promptTokenCount: 15,
            },
        }, 'gemini-2.5-flash');
        expect(response.finishReason).toBe('content_filter');
        expect(response.text).toBe('');
        expect(response.toolCalls).toEqual([]);
    });
    it('normalizes additional Gemini finish reasons', () => {
        expect(translateGeminiResponse({
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
        }, 'gemini-2.5-flash').finishReason).toBe('length');
        expect(translateGeminiResponse({
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
        }, 'gemini-2.5-flash').finishReason).toBe('content_filter');
        expect(translateGeminiResponse({
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
        }, 'gemini-2.5-flash').finishReason).toBe('error');
        expect(translateGeminiResponse({
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
        }, 'gemini-2.5-flash').finishReason).toBe('stop');
    });
    it('throws if a response has no candidates and no block reason', () => {
        expect(() => translateGeminiResponse({
            usageMetadata: {
                candidatesTokenCount: 0,
                promptTokenCount: 15,
            },
        }, 'gemini-2.5-flash')).toThrow(ProviderError);
    });
    it('maps Gemini API errors into typed errors', async () => {
        const authError = await mapGeminiError(new Response(JSON.stringify({
            error: {
                message: 'Bad key',
                status: 'UNAUTHENTICATED',
            },
        }), {
            headers: { 'x-goog-request-id': 'req_auth' },
            status: 401,
        }), 'gemini-2.5-flash');
        const contextError = await mapGeminiError(new Response(JSON.stringify({
            error: {
                message: 'Prompt exceeds the context window',
                status: 'INVALID_ARGUMENT',
            },
        }), {
            status: 400,
        }), 'gemini-2.5-flash');
        const rateLimitError = await mapGeminiError(new Response(JSON.stringify({
            error: {
                details: [{ retryDelay: '2s' }],
                message: 'Slow down',
                status: 'RESOURCE_EXHAUSTED',
            },
        }), {
            status: 429,
        }), 'gemini-2.5-flash');
        expect(authError).toBeInstanceOf(AuthenticationError);
        expect(authError.requestId).toBe('req_auth');
        expect(contextError).toBeInstanceOf(ContextLimitError);
        expect(rateLimitError).toBeInstanceOf(RateLimitError);
        expect(rateLimitError.details).toEqual({
            errorDetails: [{ retryDelay: '2s' }],
        });
    });
    it('maps generic provider errors on invalid JSON bodies', async () => {
        const providerError = await mapGeminiError(new Response('not-json', {
            status: 500,
        }), undefined);
        expect(providerError).toBeInstanceOf(ProviderError);
    });
    it('maps permission and generic provider errors', async () => {
        const authError = await mapGeminiError(new Response(JSON.stringify({
            error: {
                message: 'No access',
                status: 'PERMISSION_DENIED',
            },
        }), {
            status: 403,
        }), 'gemini-2.5-flash');
        const providerError = await mapGeminiError(new Response(JSON.stringify({
            error: {
                message: 'Backend unavailable',
                status: 'UNAVAILABLE',
            },
        }), {
            status: 503,
        }), 'gemini-2.5-flash');
        expect(authError).toBeInstanceOf(AuthenticationError);
        expect(providerError).toBeInstanceOf(ProviderError);
    });
    it('performs a complete Gemini request with auth headers', async () => {
        const signal = new AbortController().signal;
        const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
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
        }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }));
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
        const request = fetchImplementation.mock.calls[0];
        const headers = request[1].headers;
        expect(result.text).toBe('Hello there');
        expect(request[0]).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
        expect(headers['x-goog-api-key']).toBe('gemini-key');
        expect(request[1].signal).toBe(signal);
    });
    it('streams text chunks and done events', async () => {
        const adapter = new GeminiAdapter({
            apiKey: 'gemini-key',
            fetchImplementation: vi.fn(async () => new Response(makeSSEStream([
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
            ]), {
                headers: { 'content-type': 'text/event-stream' },
                status: 200,
            })),
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
    it('streams tool calls from complete functionCall chunks', async () => {
        const adapter = new GeminiAdapter({
            apiKey: 'gemini-key',
            fetchImplementation: vi.fn(async () => new Response(makeSSEStream([
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
            ]), {
                headers: { 'content-type': 'text/event-stream' },
                status: 200,
            })),
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
                result: { city: 'Berlin' },
                type: 'tool-call-result',
            },
            expect.objectContaining({
                finishReason: 'tool_call',
                type: 'done',
            }),
        ]);
    });
    it('deduplicates repeated streamed functionCall chunks and preserves blocked finish state', async () => {
        const adapter = new GeminiAdapter({
            apiKey: 'gemini-key',
            fetchImplementation: vi.fn(async () => new Response(makeSSEStream([
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
            ]), {
                headers: { 'content-type': 'text/event-stream' },
                status: 200,
            })),
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
                result: { city: 'Berlin' },
                type: 'tool-call-result',
            },
            expect.objectContaining({
                finishReason: 'tool_call',
                type: 'done',
            }),
        ]);
    });
    it('rejects unsupported structures and missing stream bodies before or during fetch', async () => {
        expect(() => translateGeminiRequest({
            messages: [
                {
                    content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
                    role: 'system',
                },
            ],
            model: 'gemini-2.5-flash',
        })).toThrow(ProviderCapabilityError);
        expect(() => translateGeminiRequest({
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
        })).toThrow(ProviderCapabilityError);
        expect(() => translateGeminiRequest({
            messages: [
                {
                    content: [{ mediaType: 'audio/wav', type: 'audio' }],
                    role: 'user',
                },
            ],
            model: 'gemini-2.5-flash',
        })).toThrow('Gemini audio parts require data or a URL.');
        expect(() => translateGeminiRequest({
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
        })).toThrow(ProviderCapabilityError);
        const registry = new ModelRegistry();
        registry.register({
            contextWindow: 32000,
            id: 'mock-gemini-no-capabilities',
            inputPrice: 1,
            lastUpdated: '2026-04-15',
            outputPrice: 2,
            provider: 'google',
            supportsStreaming: false,
            supportsTools: false,
            supportsVision: false,
        });
        const fetchImplementation = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const adapter = new GeminiAdapter({
            apiKey: 'gemini-key',
            fetchImplementation,
            modelRegistry: registry,
        });
        await expect(adapter.complete({
            messages: [
                {
                    content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
                    role: 'user',
                },
            ],
            model: 'mock-gemini-no-capabilities',
        })).rejects.toBeInstanceOf(ProviderCapabilityError);
        await expect(adapter.complete({
            messages: [{ content: 'Hello', role: 'user' }],
            model: 'mock-gemini-no-capabilities',
            tools: [
                {
                    description: 'Lookup',
                    name: 'lookup',
                    parameters: { type: 'object' },
                },
            ],
        })).rejects.toBeInstanceOf(ProviderCapabilityError);
        await expect(adapter.stream({
            messages: [{ content: 'Hello', role: 'user' }],
            model: 'mock-gemini-no-capabilities',
        }).next()).rejects.toBeInstanceOf(ProviderCapabilityError);
        const streamAdapter = new GeminiAdapter({
            apiKey: 'gemini-key',
            fetchImplementation: vi
                .fn()
                .mockResolvedValueOnce(new Response(null, { status: 200 })),
        });
        await expect(streamAdapter.stream({
            messages: [{ content: 'Hello', role: 'user' }],
            model: 'gemini-2.5-flash',
        }).next()).rejects.toBeInstanceOf(ProviderError);
        expect(fetchImplementation).not.toHaveBeenCalled();
    });
    it('supports Gemini cache lifecycle requests', async () => {
        const fetchImplementation = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
            displayName: 'Support FAQ',
            model: 'models/gemini-2.5-flash',
            name: 'cachedContents/cache_1',
        }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
            displayName: 'Support FAQ',
            model: 'models/gemini-2.5-flash',
            name: 'cachedContents/cache_1',
        }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
            cachedContents: [
                {
                    model: 'models/gemini-2.5-flash',
                    name: 'cachedContents/cache_1',
                },
            ],
            nextPageToken: 'next-token',
        }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
            expireTime: '2026-04-21T12:00:00Z',
            model: 'models/gemini-2.5-flash',
            name: 'cachedContents/cache_1',
        }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }))
            .mockResolvedValueOnce(new Response('{}', {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }));
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
        const listed = await adapter.listCaches({ pageSize: 10, pageToken: 'cursor-1' });
        const updated = await adapter.updateCache('cache_1', {
            expireTime: '2026-04-21T12:00:00Z',
        });
        await adapter.deleteCache('cache_1');
        expect(created.name).toBe('cachedContents/cache_1');
        expect(fetched.name).toBe('cachedContents/cache_1');
        expect(listed.nextPageToken).toBe('next-token');
        expect(updated.expireTime).toBe('2026-04-21T12:00:00Z');
        const createRequest = fetchImplementation.mock.calls[0];
        const getRequest = fetchImplementation.mock.calls[1];
        const listRequest = fetchImplementation.mock.calls[2];
        const updateRequest = fetchImplementation.mock.calls[3];
        const deleteRequest = fetchImplementation.mock.calls[4];
        expect(createRequest[0]).toContain('/v1beta/cachedContents');
        expect(JSON.parse(String(createRequest[1].body))).toMatchObject({
            model: 'models/gemini-2.5-flash',
            ttl: '600s',
        });
        expect(getRequest[0]).toContain('/v1beta/cachedContents/cache_1');
        expect(listRequest[0]).toContain('/v1beta/cachedContents?pageSize=10&pageToken=cursor-1');
        expect(updateRequest[0]).toContain('/v1beta/cachedContents/cache_1?updateMask=expireTime');
        expect(JSON.parse(String(updateRequest[1].body))).toEqual({
            expireTime: '2026-04-21T12:00:00Z',
        });
        expect(deleteRequest[0]).toContain('/v1beta/cachedContents/cache_1');
    });
});
function makeSSEStream(events) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            controller.close();
        },
    });
}
