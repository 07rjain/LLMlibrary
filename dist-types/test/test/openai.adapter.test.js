import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ContextLimitError, ProviderCapabilityError, ProviderError, RateLimitError, } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import { OpenAIAdapter, mapOpenAIError, translateOpenAIRequest, translateOpenAIResponse, translateOpenAIToolChoice, } from '../src/providers/openai.js';
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
        const response = translateOpenAIResponse({
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
        }, new ModelRegistry(), 'gpt-4o');
        expect(response.model).toBe('gpt-4o');
        expect(response.usage.inputTokens).toBe(8);
    });
    it('throws if a response has invalid tool arguments', () => {
        expect(() => translateOpenAIResponse({
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
            fetchImplementation: vi.fn(async () => new Response(makeSSEStream([
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
                    content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
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
    it('normalizes incomplete and failed finish reasons', () => {
        expect(translateOpenAIResponse({
            id: 'resp_len',
            incomplete_details: { reason: 'max_output_tokens' },
            model: 'gpt-4o',
            object: 'response',
            output: [],
            status: 'incomplete',
        }).finishReason).toBe('length');
        expect(translateOpenAIResponse({
            id: 'resp_filter',
            incomplete_details: { reason: 'content_filter' },
            model: 'gpt-4o',
            object: 'response',
            output: [],
            status: 'incomplete',
        }).finishReason).toBe('content_filter');
        expect(translateOpenAIResponse({
            error: { message: 'failed' },
            id: 'resp_error',
            model: 'gpt-4o',
            object: 'response',
            output: [],
            status: 'failed',
        }).finishReason).toBe('error');
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
