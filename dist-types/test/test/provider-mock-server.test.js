import { afterEach, describe, expect, it } from 'vitest';
import { RateLimitError } from '../src/errors.js';
import { AnthropicAdapter } from '../src/providers/anthropic.js';
import { GeminiAdapter } from '../src/providers/gemini.js';
import { OpenAIAdapter } from '../src/providers/openai.js';
import { jsonResponse, sseResponse, startMockHttpServer, } from './helpers/mock-http-server.js';
describe('provider mock servers', () => {
    const servers = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => server.close()));
    });
    it('serves realistic OpenAI text, tool, stream, and error responses', async () => {
        const server = await startServerOrSkip((request) => handleOpenAIRequest(request));
        if (!server) {
            return;
        }
        servers.push(server);
        const adapter = new OpenAIAdapter({
            apiKey: 'openai-test-key',
            baseUrl: server.baseUrl,
            retryOptions: { maxAttempts: 1 },
        });
        const textResponse = await adapter.complete({
            messages: [{ content: 'Say hello from the mock server.', role: 'user' }],
            model: 'gpt-4o',
        });
        const toolResponse = await adapter.complete({
            messages: [{ content: 'Call the weather tool.', role: 'user' }],
            model: 'gpt-4o',
            tools: [weatherTool],
        });
        const streamChunks = [];
        for await (const chunk of adapter.stream({
            messages: [{ content: 'Stream a short answer.', role: 'user' }],
            model: 'gpt-4o',
        })) {
            streamChunks.push(chunk);
        }
        await expect(adapter.complete({
            messages: [{ content: 'RATE_LIMIT', role: 'user' }],
            model: 'gpt-4o',
        })).rejects.toBeInstanceOf(RateLimitError);
        expect(textResponse).toMatchObject({
            finishReason: 'stop',
            provider: 'openai',
            text: 'OpenAI mock says hello.',
        });
        expect(toolResponse).toMatchObject({
            finishReason: 'tool_call',
            text: 'Checking weather.',
            toolCalls: [{ args: { city: 'Berlin' }, id: 'call_1', name: 'weather_lookup' }],
        });
        expect(streamChunks).toEqual([
            { delta: 'OpenAI ', type: 'text-delta' },
            { delta: 'stream mock.', type: 'text-delta' },
            expect.objectContaining({
                finishReason: 'stop',
                type: 'done',
            }),
        ]);
        expect(server.requests).toHaveLength(4);
        expect(server.requests[0]?.pathname).toBe('/v1/responses');
        expect(server.requests[0]?.headers.authorization).toBe('Bearer openai-test-key');
        expect(server.requests[1]?.json).toMatchObject({
            tools: [
                {
                    name: 'weather_lookup',
                    strict: false,
                    type: 'function',
                },
            ],
        });
        expect(server.requests[2]?.json).toMatchObject({
            model: 'gpt-4o',
            store: false,
            stream: true,
        });
    });
    it('serves realistic Anthropic text, tool, stream, and error responses', async () => {
        const server = await startServerOrSkip((request) => handleAnthropicRequest(request));
        if (!server) {
            return;
        }
        servers.push(server);
        const adapter = new AnthropicAdapter({
            apiKey: 'anthropic-test-key',
            baseUrl: server.baseUrl,
            retryOptions: { maxAttempts: 1 },
        });
        const textResponse = await adapter.complete({
            maxTokens: 128,
            messages: [{ content: 'Say hello from the mock server.', role: 'user' }],
            model: 'claude-sonnet-4-6',
        });
        const toolResponse = await adapter.complete({
            maxTokens: 128,
            messages: [{ content: 'Call the weather tool.', role: 'user' }],
            model: 'claude-sonnet-4-6',
            tools: [weatherTool],
        });
        const streamChunks = [];
        for await (const chunk of adapter.stream({
            maxTokens: 128,
            messages: [{ content: 'Stream a short answer.', role: 'user' }],
            model: 'claude-sonnet-4-6',
        })) {
            streamChunks.push(chunk);
        }
        await expect(adapter.complete({
            maxTokens: 128,
            messages: [{ content: 'RATE_LIMIT', role: 'user' }],
            model: 'claude-sonnet-4-6',
        })).rejects.toBeInstanceOf(RateLimitError);
        expect(textResponse).toMatchObject({
            finishReason: 'stop',
            provider: 'anthropic',
            text: 'Anthropic mock says hello.',
        });
        expect(toolResponse).toMatchObject({
            finishReason: 'tool_call',
            text: 'Checking weather.',
            toolCalls: [{ args: { city: 'Berlin' }, id: 'tool_1', name: 'weather_lookup' }],
        });
        expect(streamChunks).toEqual([
            { delta: 'Anthropic ', type: 'text-delta' },
            { delta: 'stream mock.', type: 'text-delta' },
            expect.objectContaining({
                finishReason: 'stop',
                type: 'done',
            }),
        ]);
        expect(server.requests).toHaveLength(4);
        expect(server.requests[0]?.pathname).toBe('/v1/messages');
        expect(server.requests[0]?.headers['x-api-key']).toBe('anthropic-test-key');
        expect(server.requests[0]?.headers['anthropic-version']).toBe('2023-06-01');
        expect(server.requests[1]?.json).toMatchObject({
            tools: [
                {
                    name: 'weather_lookup',
                },
            ],
        });
        expect(server.requests[2]?.json).toMatchObject({
            stream: true,
        });
    });
    it('serves realistic Gemini text, tool, stream, and error responses', async () => {
        const server = await startServerOrSkip((request) => handleGeminiRequest(request));
        if (!server) {
            return;
        }
        servers.push(server);
        const adapter = new GeminiAdapter({
            apiKey: 'gemini-test-key',
            baseUrl: server.baseUrl,
            retryOptions: { maxAttempts: 1 },
        });
        const textResponse = await adapter.complete({
            messages: [{ content: 'Say hello from the mock server.', role: 'user' }],
            model: 'gemini-2.5-flash',
        });
        const toolResponse = await adapter.complete({
            messages: [{ content: 'Call the weather tool.', role: 'user' }],
            model: 'gemini-2.5-flash',
            tools: [weatherTool],
        });
        const streamChunks = [];
        for await (const chunk of adapter.stream({
            messages: [{ content: 'Stream a short answer.', role: 'user' }],
            model: 'gemini-2.5-flash',
        })) {
            streamChunks.push(chunk);
        }
        await expect(adapter.complete({
            messages: [{ content: 'RATE_LIMIT', role: 'user' }],
            model: 'gemini-2.5-flash',
        })).rejects.toBeInstanceOf(RateLimitError);
        expect(textResponse).toMatchObject({
            finishReason: 'stop',
            provider: 'google',
            text: 'Gemini mock says hello.',
        });
        expect(toolResponse).toMatchObject({
            finishReason: 'tool_call',
            text: 'Checking weather.',
            toolCalls: [
                {
                    args: { city: 'Berlin' },
                    id: 'gemini_tool_0_1_weather_lookup',
                    name: 'weather_lookup',
                },
            ],
        });
        expect(streamChunks).toEqual([
            { delta: 'Gemini ', type: 'text-delta' },
            { delta: 'stream mock.', type: 'text-delta' },
            expect.objectContaining({
                finishReason: 'stop',
                type: 'done',
            }),
        ]);
        expect(server.requests).toHaveLength(4);
        expect(server.requests[0]?.pathname).toContain(':generateContent');
        expect(server.requests[0]?.headers['x-goog-api-key']).toBe('gemini-test-key');
        expect(server.requests[1]?.json).toMatchObject({
            tools: [
                {
                    functionDeclarations: [{ name: 'weather_lookup' }],
                },
            ],
        });
        expect(server.requests[2]?.pathname).toContain(':streamGenerateContent');
        expect(server.requests[2]?.query.get('alt')).toBe('sse');
    });
});
const weatherTool = {
    description: 'Look up weather by city.',
    name: 'weather_lookup',
    parameters: {
        properties: {
            city: { type: 'string' },
        },
        required: ['city'],
        type: 'object',
    },
};
function handleOpenAIRequest(request) {
    const body = asRecord(request.json);
    const userText = extractOpenAIUserText(body);
    if (userText.includes('RATE_LIMIT')) {
        return jsonResponse({
            error: {
                message: 'Too many requests',
                type: 'rate_limit_error',
            },
        }, { status: 429 });
    }
    if (body.stream === true) {
        return sseResponse([
            {
                content_index: 0,
                delta: 'OpenAI ',
                item_id: 'msg_stream_1',
                output_index: 0,
                sequence_number: 1,
                type: 'response.output_text.delta',
            },
            {
                content_index: 0,
                delta: 'stream mock.',
                item_id: 'msg_stream_1',
                output_index: 0,
                sequence_number: 2,
                type: 'response.output_text.delta',
            },
            {
                response: {
                    id: 'resp_stream_1',
                    model: 'gpt-4o',
                    object: 'response',
                    output: [
                        {
                            content: [
                                {
                                    annotations: [],
                                    text: 'OpenAI stream mock.',
                                    type: 'output_text',
                                },
                            ],
                            id: 'msg_stream_1',
                            role: 'assistant',
                            status: 'completed',
                            type: 'message',
                        },
                    ],
                    status: 'completed',
                    usage: {
                        input_tokens: 12,
                        output_tokens: 4,
                    },
                },
                sequence_number: 3,
                type: 'response.completed',
            },
            '[DONE]',
        ]);
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        return jsonResponse({
            id: 'resp_tool_1',
            model: 'gpt-4o',
            object: 'response',
            output: [
                {
                    content: [
                        {
                            annotations: [],
                            text: 'Checking weather.',
                            type: 'output_text',
                        },
                    ],
                    id: 'msg_tool_1',
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
                input_tokens: 30,
                output_tokens: 6,
            },
        });
    }
    return jsonResponse({
        id: 'resp_text_1',
        model: 'gpt-4o',
        object: 'response',
        output: [
            {
                content: [
                    {
                        annotations: [],
                        text: 'OpenAI mock says hello.',
                        type: 'output_text',
                    },
                ],
                id: 'msg_text_1',
                role: 'assistant',
                status: 'completed',
                type: 'message',
            },
        ],
        status: 'completed',
        usage: {
            input_tokens: 14,
            output_tokens: 5,
        },
    });
}
function handleAnthropicRequest(request) {
    const body = asRecord(request.json);
    const userText = extractAnthropicUserText(body);
    if (userText.includes('RATE_LIMIT')) {
        return jsonResponse({
            error: {
                message: 'Slow down',
                type: 'rate_limit_error',
            },
        }, {
            headers: { 'anthropic-request-id': 'req_rate_limit' },
            status: 429,
        });
    }
    if (body.stream === true) {
        return sseResponse([
            {
                message: {
                    content: [],
                    id: 'msg_stream_1',
                    model: 'claude-sonnet-4-6',
                    role: 'assistant',
                    stop_reason: null,
                    usage: {
                        input_tokens: 12,
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
                    text: 'Anthropic ',
                    type: 'text_delta',
                },
                index: 0,
                type: 'content_block_delta',
            },
            {
                delta: {
                    text: 'stream mock.',
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
                    output_tokens: 4,
                },
            },
            {
                type: 'message_stop',
            },
        ]);
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        return jsonResponse({
            content: [
                { text: 'Checking weather.', type: 'text' },
                {
                    id: 'tool_1',
                    input: { city: 'Berlin' },
                    name: 'weather_lookup',
                    type: 'tool_use',
                },
            ],
            id: 'msg_tool_1',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            stop_reason: 'tool_use',
            usage: {
                input_tokens: 30,
                output_tokens: 6,
            },
        });
    }
    return jsonResponse({
        content: [{ text: 'Anthropic mock says hello.', type: 'text' }],
        id: 'msg_text_1',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        stop_reason: 'end_turn',
        usage: {
            input_tokens: 14,
            output_tokens: 5,
        },
    });
}
function handleGeminiRequest(request) {
    const body = asRecord(request.json);
    const userText = extractGeminiUserText(body);
    if (userText.includes('RATE_LIMIT')) {
        return jsonResponse({
            error: {
                code: 429,
                message: 'Quota exceeded',
                status: 'RESOURCE_EXHAUSTED',
            },
        }, { status: 429 });
    }
    if (request.pathname.includes(':streamGenerateContent')) {
        return sseResponse([
            {
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'Gemini ' }],
                            role: 'model',
                        },
                        index: 0,
                    },
                ],
            },
            {
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'stream mock.' }],
                            role: 'model',
                        },
                        finishReason: 'STOP',
                        index: 0,
                    },
                ],
                usageMetadata: {
                    candidatesTokenCount: 4,
                    promptTokenCount: 12,
                },
            },
        ]);
    }
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        return jsonResponse({
            candidates: [
                {
                    content: {
                        parts: [
                            { text: 'Checking weather.' },
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
                candidatesTokenCount: 6,
                promptTokenCount: 30,
            },
        });
    }
    return jsonResponse({
        candidates: [
            {
                content: {
                    parts: [{ text: 'Gemini mock says hello.' }],
                    role: 'model',
                },
                finishReason: 'STOP',
                index: 0,
            },
        ],
        usageMetadata: {
            candidatesTokenCount: 5,
            promptTokenCount: 14,
        },
    });
}
function asRecord(value) {
    return value && typeof value === 'object' ? value : {};
}
async function startServerOrSkip(handler) {
    try {
        return await startMockHttpServer(handler);
    }
    catch (error) {
        if (isSocketPermissionError(error)) {
            return null;
        }
        throw error;
    }
}
function extractOpenAIUserText(body) {
    const input = Array.isArray(body.input) ? body.input : [];
    return input
        .map((item) => {
        const entry = asRecord(item);
        if (entry.type !== 'message' || entry.role !== 'user') {
            return '';
        }
        return extractTextParts(entry.content);
    })
        .join(' ');
}
function extractAnthropicUserText(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages
        .map((message) => {
        const entry = asRecord(message);
        if (entry.role !== 'user') {
            return '';
        }
        return extractTextParts(entry.content);
    })
        .join(' ');
}
function extractGeminiUserText(body) {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    return contents
        .map((content) => {
        const entry = asRecord(content);
        if (entry.role !== 'user') {
            return '';
        }
        const parts = Array.isArray(entry.parts) ? entry.parts : [];
        return parts
            .map((part) => {
            const normalized = asRecord(part);
            return typeof normalized.text === 'string' ? normalized.text : '';
        })
            .join(' ');
    })
        .join(' ');
}
function extractTextParts(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((part) => {
        const normalized = asRecord(part);
        if (typeof normalized.text === 'string') {
            return normalized.text;
        }
        if (typeof normalized.image_url === 'string') {
            return normalized.image_url;
        }
        const imageUrl = asRecord(normalized.image_url);
        return typeof imageUrl.url === 'string' ? imageUrl.url : '';
    })
        .join(' ');
}
function isSocketPermissionError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    return ('code' in error &&
        error.code === 'EPERM' &&
        /listen|operation not permitted/i.test(error.message));
}
