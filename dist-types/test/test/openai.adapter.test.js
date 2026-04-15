import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ContextLimitError, ProviderCapabilityError, ProviderError, RateLimitError, } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import { OpenAIAdapter, mapOpenAIError, translateOpenAIRequest, translateOpenAIResponse, translateOpenAIToolChoice } from '../src/providers/openai.js';
describe('OpenAI adapter', () => {
    it('translates canonical requests into chat completions payloads', () => {
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
            max_completion_tokens: 256,
            model: 'gpt-4o',
            parallel_tool_calls: false,
            tool_choice: {
                function: { name: 'weather_lookup' },
                type: 'function',
            },
        });
        expect(request.messages).toEqual([
            { content: 'Pinned system', role: 'developer' },
            { content: 'You are helpful.', role: 'developer' },
            {
                content: [
                    { text: 'Hello', type: 'text' },
                    {
                        image_url: { url: 'https://example.com/cat.png' },
                        type: 'image_url',
                    },
                ],
                role: 'user',
            },
            {
                content: null,
                role: 'assistant',
                tool_calls: [
                    {
                        function: {
                            arguments: '{"city":"Berlin"}',
                            name: 'weather_lookup',
                        },
                        id: 'call_1',
                        type: 'function',
                    },
                ],
            },
            {
                content: '{"temperature":18}',
                role: 'tool',
                tool_call_id: 'call_1',
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
    it('translates responses into canonical responses', () => {
        const response = translateOpenAIResponse({
            choices: [
                {
                    finish_reason: 'tool_calls',
                    index: 0,
                    message: {
                        content: 'Checking.',
                        role: 'assistant',
                        tool_calls: [
                            {
                                function: {
                                    arguments: '{"city":"Berlin"}',
                                    name: 'weather_lookup',
                                },
                                id: 'call_1',
                                type: 'function',
                            },
                        ],
                    },
                },
            ],
            created: 1,
            id: 'chatcmpl_1',
            model: 'gpt-4o',
            object: 'chat.completion',
            usage: {
                completion_tokens: 12,
                prompt_tokens: 40,
                prompt_tokens_details: { cached_tokens: 10 },
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
    });
    it('falls back to the requested model when OpenAI returns a versioned model id', () => {
        const response = translateOpenAIResponse({
            choices: [
                {
                    finish_reason: 'stop',
                    index: 0,
                    message: {
                        content: 'Hello',
                        role: 'assistant',
                    },
                },
            ],
            created: 1,
            id: 'chatcmpl_1',
            model: 'gpt-4o-2024-08-06',
            object: 'chat.completion',
            usage: {
                completion_tokens: 4,
                prompt_tokens: 8,
            },
        }, new ModelRegistry(), 'gpt-4o');
        expect(response.model).toBe('gpt-4o');
        expect(response.usage.inputTokens).toBe(8);
    });
    it('throws if a response has invalid tool arguments', () => {
        expect(() => translateOpenAIResponse({
            choices: [
                {
                    finish_reason: 'tool_calls',
                    index: 0,
                    message: {
                        content: null,
                        role: 'assistant',
                        tool_calls: [
                            {
                                function: {
                                    arguments: 'not-json',
                                    name: 'weather_lookup',
                                },
                                id: 'call_1',
                                type: 'function',
                            },
                        ],
                    },
                },
            ],
            created: 1,
            id: 'chatcmpl_1',
            model: 'gpt-4o',
            object: 'chat.completion',
        })).toThrow(ProviderError);
    });
    it('maps OpenAI API errors into typed errors', async () => {
        const authError = await mapOpenAIError(new Response(JSON.stringify({
            error: {
                message: 'Bad key',
                type: 'authentication_error',
            },
        }), {
            headers: { 'x-request-id': 'req_auth' },
            status: 401,
        }), 'gpt-4o');
        const contextError = await mapOpenAIError(new Response(JSON.stringify({
            error: {
                code: 'context_length_exceeded',
                message: 'Context too long',
                type: 'invalid_request_error',
            },
        }), {
            status: 400,
        }), 'gpt-4o');
        const rateLimitError = await mapOpenAIError(new Response(JSON.stringify({
            error: {
                message: 'Too many requests',
                type: 'rate_limit_error',
            },
        }), {
            status: 429,
        }), 'gpt-4o');
        expect(authError).toBeInstanceOf(AuthenticationError);
        expect(authError.requestId).toBe('req_auth');
        expect(contextError).toBeInstanceOf(ContextLimitError);
        expect(rateLimitError).toBeInstanceOf(RateLimitError);
    });
    it('maps generic provider errors on invalid JSON bodies', async () => {
        const providerError = await mapOpenAIError(new Response('not-json', {
            status: 500,
        }), undefined);
        expect(providerError).toBeInstanceOf(ProviderError);
    });
    it('performs a complete request with auth headers', async () => {
        const signal = new AbortController().signal;
        const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
            choices: [
                {
                    finish_reason: 'stop',
                    index: 0,
                    message: {
                        content: 'Hello there',
                        role: 'assistant',
                    },
                },
            ],
            created: 1,
            id: 'chatcmpl_1',
            model: 'gpt-4o',
            object: 'chat.completion',
            usage: {
                completion_tokens: 10,
                prompt_tokens: 20,
            },
        }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }));
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
        const request = fetchImplementation.mock.calls[0];
        const headers = request[1].headers;
        expect(result.text).toBe('Hello there');
        expect(request[0]).toContain('/v1/chat/completions');
        expect(headers.Authorization).toBe('Bearer openai-key');
        expect(headers['OpenAI-Organization']).toBe('org_123');
        expect(headers['OpenAI-Project']).toBe('proj_123');
        expect(request[1].signal).toBe(signal);
    });
    it('streams text deltas and done events', async () => {
        const adapter = new OpenAIAdapter({
            apiKey: 'openai-key',
            fetchImplementation: vi.fn(async () => new Response(makeSSEStream([
                {
                    choices: [
                        {
                            delta: {
                                content: 'Hello ',
                                role: 'assistant',
                            },
                            finish_reason: null,
                            index: 0,
                        },
                    ],
                    created: 1,
                    id: 'chatcmpl_1',
                    model: 'gpt-4o',
                    object: 'chat.completion.chunk',
                },
                {
                    choices: [
                        {
                            delta: {
                                content: 'world',
                            },
                            finish_reason: 'stop',
                            index: 0,
                        },
                    ],
                    created: 1,
                    id: 'chatcmpl_1',
                    model: 'gpt-4o',
                    object: 'chat.completion.chunk',
                },
                {
                    choices: [],
                    created: 1,
                    id: 'chatcmpl_1',
                    model: 'gpt-4o',
                    object: 'chat.completion.chunk',
                    usage: {
                        completion_tokens: 12,
                        prompt_tokens: 20,
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
            fetchImplementation: vi.fn(async () => new Response(makeSSEStream([
                {
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        function: {
                                            arguments: '{"city":"Ber',
                                            name: 'weather_lookup',
                                        },
                                        id: 'call_1',
                                        index: 0,
                                        type: 'function',
                                    },
                                ],
                            },
                            finish_reason: null,
                            index: 0,
                        },
                    ],
                    created: 1,
                    id: 'chatcmpl_1',
                    model: 'gpt-4o',
                    object: 'chat.completion.chunk',
                },
                {
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        function: {
                                            arguments: 'lin"}',
                                        },
                                        index: 0,
                                    },
                                ],
                            },
                            finish_reason: 'tool_calls',
                            index: 0,
                        },
                    ],
                    created: 1,
                    id: 'chatcmpl_1',
                    model: 'gpt-4o',
                    object: 'chat.completion.chunk',
                    usage: {
                        completion_tokens: 12,
                        prompt_tokens: 20,
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
                .fn()
                .mockResolvedValueOnce(new Response(null, { status: 200 })),
        });
        await expect(adapter.complete({
            messages: [
                {
                    content: [{ data: 'pdf', mediaType: 'application/pdf', type: 'document' }],
                    role: 'user',
                },
            ],
            model: 'gpt-4o',
        })).rejects.toBeInstanceOf(ProviderCapabilityError);
        await expect(adapter.complete({
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
        })).rejects.toBeInstanceOf(ProviderCapabilityError);
        await expect(adapter.complete({
            messages: [
                {
                    content: [
                        { type: 'image_url', url: 'https://example.com/image.png' },
                    ],
                    role: 'assistant',
                },
            ],
            model: 'gpt-4o',
        })).rejects.toBeInstanceOf(ProviderCapabilityError);
        await expect(adapter.stream({
            messages: [{ content: 'Hello', role: 'user' }],
            model: 'gpt-4o',
        }).next()).rejects.toBeInstanceOf(ProviderError);
    });
    it('throws for empty choices and normalizes additional finish reasons', () => {
        expect(() => translateOpenAIResponse({
            choices: [],
            created: 1,
            id: 'chatcmpl_1',
            model: 'gpt-4o',
            object: 'chat.completion',
        })).toThrow(ProviderError);
        expect(translateOpenAIResponse({
            choices: [
                {
                    finish_reason: 'length',
                    index: 0,
                    message: { content: 'Truncated', role: 'assistant' },
                },
            ],
            created: 1,
            id: 'chatcmpl_2',
            model: 'gpt-4o',
            object: 'chat.completion',
        }).finishReason).toBe('length');
        expect(translateOpenAIResponse({
            choices: [
                {
                    finish_reason: 'content_filter',
                    index: 0,
                    message: { content: '', role: 'assistant' },
                },
            ],
            created: 1,
            id: 'chatcmpl_3',
            model: 'gpt-4o',
            object: 'chat.completion',
        }).finishReason).toBe('content_filter');
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
        await expect(adapter.complete({
            messages: [{ content: 'Hello', role: 'user' }],
            model: 'mock-openai-no-capabilities',
            tools: [
                {
                    description: 'Lookup',
                    name: 'lookup',
                    parameters: { type: 'object' },
                },
            ],
        })).rejects.toBeInstanceOf(ProviderCapabilityError);
        await expect(adapter.complete({
            messages: [
                {
                    content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
                    role: 'user',
                },
            ],
            model: 'mock-openai-no-capabilities',
        })).rejects.toBeInstanceOf(ProviderCapabilityError);
        await expect(adapter.stream({
            messages: [{ content: 'Hello', role: 'user' }],
            model: 'mock-openai-no-capabilities',
        }).next()).rejects.toBeInstanceOf(ProviderCapabilityError);
    });
});
function makeSSEStream(events) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    });
}
