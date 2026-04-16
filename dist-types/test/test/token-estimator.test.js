import { describe, expect, it, vi } from 'vitest';
import { anthropicCountTokens, estimateMessageTokens, estimateTokens, geminiCountTokens, openaiCountTokens, } from '../src/utils/token-estimator.js';
describe('token estimator', () => {
    it('estimates tokens from text', () => {
        expect(estimateTokens('1234567')).toBe(2);
    });
    it('estimates tokens from structured messages', () => {
        const count = estimateMessageTokens([
            { content: 'hello world', role: 'user' },
            {
                content: [
                    { data: 'audio-bytes', mediaType: 'audio/wav', type: 'audio' },
                    {
                        data: 'document-body',
                        mediaType: 'application/pdf',
                        title: 'Spec',
                        type: 'document',
                    },
                    { data: 'base64-image', mediaType: 'image/png', type: 'image_base64' },
                    { type: 'image_url', url: 'https://example.com/image.png' },
                    { text: 'result', type: 'text' },
                    {
                        args: { city: 'Berlin' },
                        id: 'tool_1',
                        name: 'weather_lookup',
                        type: 'tool_call',
                    },
                    {
                        name: 'weather_lookup',
                        result: { temperature: 18 },
                        toolCallId: 'tool_1',
                        type: 'tool_result',
                    },
                ],
                role: 'assistant',
            },
        ]);
        expect(count).toBeGreaterThan(0);
    });
    it('calls the Anthropic token count endpoint', async () => {
        const signal = new AbortController().signal;
        const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ input_tokens: 123 }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }));
        const count = await anthropicCountTokens({
            apiKey: 'test-key',
            body: { messages: [] },
            fetchImplementation,
            signal,
        });
        const anthropicCalls = fetchImplementation.mock.calls;
        expect(count).toBe(123);
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
        expect(anthropicCalls[0]?.[1]?.signal).toBe(signal);
    });
    it('calls the Gemini token count endpoint', async () => {
        const signal = new AbortController().signal;
        const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ totalTokens: 456 }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
        }));
        const count = await geminiCountTokens({
            apiKey: 'test-key',
            body: { contents: [] },
            fetchImplementation,
            model: 'gemini-2.5-flash',
            signal,
        });
        const geminiCalls = fetchImplementation.mock.calls;
        expect(count).toBe(456);
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
        expect(geminiCalls[0]?.[1]?.signal).toBe(signal);
    });
    it('counts OpenAI chat messages with the tokenizer wrapper', async () => {
        const baseCount = await openaiCountTokens({
            messages: [{ content: 'Hello world', role: 'user' }],
            model: 'gpt-4o',
        });
        const withSystemCount = await openaiCountTokens({
            messages: [{ content: 'Hello world', role: 'user' }],
            model: 'gpt-4o',
            system: 'Be concise.',
            tools: [
                {
                    description: 'Look up weather',
                    name: 'lookup_weather',
                    parameters: { type: 'object' },
                },
            ],
        });
        expect(baseCount).toBeGreaterThan(0);
        expect(withSystemCount).toBeGreaterThan(baseCount);
    });
    it('rejects OpenAI exact token counting for unsupported multimodal parts', async () => {
        await expect(openaiCountTokens({
            messages: [
                {
                    content: [{ type: 'image_url', url: 'https://example.com/image.png' }],
                    role: 'user',
                },
            ],
            model: 'gpt-4o',
        })).rejects.toThrow('OpenAI token counting only supports text and tool message parts.');
    });
    it('throws when token count endpoints fail', async () => {
        const anthropicFetch = vi.fn(async () => new Response('', { status: 500 }));
        const geminiFetch = vi.fn(async () => new Response('', { status: 503 }));
        await expect(anthropicCountTokens({
            apiKey: 'test-key',
            body: { messages: [] },
            fetchImplementation: anthropicFetch,
        })).rejects.toThrow('Anthropic token count request failed with 500.');
        await expect(geminiCountTokens({
            apiKey: 'test-key',
            body: { contents: [] },
            fetchImplementation: geminiFetch,
            model: 'gemini-2.5-flash',
        })).rejects.toThrow('Gemini token count request failed with 503.');
    });
});
