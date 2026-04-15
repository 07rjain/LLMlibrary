import { describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../src/client.js';
import { SlidingWindowStrategy, SummarisationStrategy } from '../src/context-manager.js';
import { Conversation } from '../src/conversation.js';
import { BudgetExceededError, MaxToolRoundsError } from '../src/errors.js';
import { InMemorySessionStore } from '../src/session-store.js';
describe('Conversation', () => {
    it('generates a session id when one is not supplied', () => {
        const conversation = new Conversation({
            complete: vi.fn(),
            stream: vi.fn(),
        }, {});
        expect(conversation.id).toBeTruthy();
        expect(typeof conversation.id).toBe('string');
    });
    it('handles minimal request and response paths without optional config', async () => {
        const client = {
            complete: vi.fn(async () => ({
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
            })),
            stream: vi.fn(async function* () {
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
        expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({
            messages: [{ content: 'Hi', role: 'user' }],
            sessionId: conversation.id,
        }));
        expect(client.stream).toHaveBeenCalledWith(expect.objectContaining({
            messages: [
                { content: 'Hi', role: 'user' },
                { content: '', role: 'assistant' },
                { content: 'Again', role: 'user' },
            ],
            model: 'mock-model',
            provider: 'mock',
            sessionId: conversation.id,
        }));
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
    it('sends messages, updates totals, and auto-saves snapshots', async () => {
        const store = new InMemorySessionStore({
            now: () => new Date('2026-04-15T10:00:00.000Z'),
        });
        const client = {
            complete: vi.fn(async () => ({
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
                },
            })),
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
        });
        expect(stored?.snapshot.messages).toEqual(conversation.history);
        expect(stored?.meta.totalCostUSD).toBe(0.01);
    });
    it('streams responses and commits state on done', async () => {
        const client = {
            complete: vi.fn(),
            stream: vi.fn(async function* () {
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
        const chunks = [];
        for await (const chunk of conversation.sendStream('Hi')) {
            chunks.push(chunk);
        }
        expect(chunks).toEqual([
            { delta: 'Hello ', type: 'text-delta' },
            { delta: 'world', type: 'text-delta' },
            expect.objectContaining({ finishReason: 'stop', type: 'done' }),
        ]);
        expect(conversation.history).toEqual([
            { content: 'Hi', role: 'user' },
            { content: 'Hello world', role: 'assistant' },
        ]);
        expect(conversation.totals.costUSD).toBe(0.002);
    });
    it('streams tool calls into assistant message parts', async () => {
        const client = {
            complete: vi.fn(),
            stream: vi.fn(async function* () {
                yield { id: 'tool_1', name: 'lookup', type: 'tool-call-start' };
                yield {
                    id: 'tool_1',
                    name: 'lookup',
                    result: { city: 'Berlin' },
                    type: 'tool-call-result',
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
        ]);
    });
    it('auto-executes tool calls and returns the final assistant response', async () => {
        const execute = vi.fn(async (args) => ({
            forecast: `${String(args.city)}: sunny`,
        }));
        const complete = vi
            .fn()
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
            toolCalls: [{ args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' }],
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
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
            model: 'gpt-4o',
            provider: 'openai',
            sessionId: 'tool-loop-session',
            tools: [buildTool('lookup_weather', execute)],
        });
        const response = await conversation.send('What is the weather in Berlin?');
        expect(execute).toHaveBeenCalledWith({ city: 'Berlin' }, expect.objectContaining({
            model: 'gpt-4o',
            provider: 'openai',
            sessionId: 'tool-loop-session',
        }));
        expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
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
        }));
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
            .fn()
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
            toolCalls: [{ args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' }],
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
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
            model: 'gpt-4o',
            toolChoice: { name: 'lookup_weather', type: 'tool' },
            tools: [buildTool('lookup_weather', vi.fn(async () => ({ ok: true })))],
        });
        await conversation.send('Use the tool.');
        expect(complete).toHaveBeenNthCalledWith(1, expect.objectContaining({
            toolChoice: { name: 'lookup_weather', type: 'tool' },
        }));
        expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
            toolChoice: { type: 'auto' },
        }));
    });
    it('runs multiple tool calls in parallel', async () => {
        let activeExecutions = 0;
        let maxActiveExecutions = 0;
        const createParallelTool = (name) => buildTool(name, vi.fn(async () => {
            activeExecutions += 1;
            maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
            await new Promise((resolve) => setTimeout(resolve, 10));
            activeExecutions -= 1;
            return { ok: true };
        }));
        const conversation = new Conversation({
            complete: vi
                .fn()
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
        }, {
            model: 'gpt-4o',
            tools: [createParallelTool('tool_a'), createParallelTool('tool_b')],
        });
        await conversation.send('Run both tools.');
        expect(maxActiveExecutions).toBe(2);
    });
    it('returns structured tool errors back to the model when execution fails', async () => {
        const complete = vi
            .fn()
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
            toolCalls: [{ args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' }],
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
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
            model: 'gpt-4o',
            tools: [
                buildTool('lookup_weather', vi.fn(async () => {
                    throw new Error('lookup failed');
                })),
            ],
        });
        const response = await conversation.send('Use the tool.');
        expect(response.text).toBe('Handled tool failure.');
        expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
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
        }));
    });
    it('resumes streaming after tool execution and emits a single final done chunk', async () => {
        const execute = vi.fn(async () => ({ forecast: 'Sunny' }));
        const stream = vi
            .fn()
            .mockImplementationOnce(async function* () {
            yield { delta: 'Checking ', type: 'text-delta' };
            yield { id: 'tool_1', name: 'lookup_weather', type: 'tool-call-start' };
            yield {
                id: 'tool_1',
                name: 'lookup_weather',
                result: { city: 'Berlin' },
                type: 'tool-call-result',
            };
            yield {
                finishReason: 'tool_call',
                type: 'done',
                usage: usage(6, 2, 0.01),
            };
        })
            .mockImplementationOnce(async function* () {
            yield { delta: 'Sunny in Berlin.', type: 'text-delta' };
            yield {
                finishReason: 'stop',
                type: 'done',
                usage: usage(5, 3, 0.02),
            };
        });
        const conversation = new Conversation({
            complete: vi.fn(),
            stream,
        }, {
            model: 'gpt-4o',
            provider: 'openai',
            sessionId: 'stream-tool-loop',
            tools: [buildTool('lookup_weather', execute)],
        });
        const chunks = [];
        for await (const chunk of conversation.sendStream('What is the weather?')) {
            chunks.push(chunk);
        }
        expect(chunks).toEqual([
            { delta: 'Checking ', type: 'text-delta' },
            { id: 'tool_1', name: 'lookup_weather', type: 'tool-call-start' },
            {
                id: 'tool_1',
                name: 'lookup_weather',
                result: { city: 'Berlin' },
                type: 'tool-call-result',
            },
            { delta: 'Sunny in Berlin.', type: 'text-delta' },
            {
                finishReason: 'stop',
                type: 'done',
                usage: {
                    cachedTokens: 0,
                    cost: '$0.03',
                    costUSD: 0.03,
                    inputTokens: 11,
                    outputTokens: 5,
                },
            },
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
    it('passes the remaining session budget into each provider round', async () => {
        const execute = vi.fn(async () => ({ forecast: 'Berlin: sunny' }));
        const complete = vi
            .fn()
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
            toolCalls: [{ args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' }],
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
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
            budgetUsd: 0.05,
            model: 'gpt-4o',
            tools: [buildTool('lookup_weather', execute)],
        });
        await conversation.send('Check the weather');
        expect(complete).toHaveBeenNthCalledWith(1, expect.objectContaining({
            budgetUsd: 0.05,
        }));
        expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
            budgetUsd: 0.04,
        }));
    });
    it('throws when the conversation budget is already exhausted', async () => {
        const client = {
            complete: vi.fn(),
            stream: vi.fn(),
        };
        const conversation = new Conversation(client, {
            budgetUsd: 0,
            model: 'gpt-4o',
        });
        await expect(conversation.send('Hi')).rejects.toBeInstanceOf(BudgetExceededError);
        expect(client.complete).not.toHaveBeenCalled();
    });
    it('throws MaxToolRoundsError when the model keeps requesting tools', async () => {
        const conversation = new Conversation({
            complete: vi
                .fn()
                .mockResolvedValue({
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
        }, {
            maxToolRounds: 1,
            model: 'gpt-4o',
            tools: [
                buildTool('lookup_weather', vi.fn(async () => ({ ok: true }))),
            ],
        });
        await expect(conversation.send('Loop forever.')).rejects.toBeInstanceOf(MaxToolRoundsError);
    });
    it('throws if a stream ends without a done chunk', async () => {
        const conversation = new Conversation({
            complete: vi.fn(),
            stream: vi.fn(async function* () {
                yield { delta: 'Partial', type: 'text-delta' };
            }),
        }, { model: 'gpt-4o', sessionId: 'session-no-done' });
        await expect(async () => {
            for await (const chunk of conversation.sendStream('Hi')) {
                void chunk;
            }
        }).rejects.toThrow('Streaming conversation ended without a done chunk.');
    });
    it('serialises, restores, and clears while preserving system and totals', async () => {
        const client = {
            complete: vi.fn(async () => ({
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
            })),
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
        const client = {
            complete: vi
                .fn()
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
    it('exports markdown transcripts with session metadata and structured parts', async () => {
        const conversation = new Conversation({
            complete: vi.fn(async () => ({
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
                toolCalls: [{ args: { city: 'Berlin' }, id: 'tool_1', name: 'lookup_weather' }],
                usage: {
                    cachedTokens: 0,
                    cost: '$0.01',
                    costUSD: 0.01,
                    inputTokens: 12,
                    outputTokens: 4,
                },
            })),
            stream: vi.fn(),
        }, {
            model: 'gpt-4o',
            sessionId: 'session-markdown',
            system: 'Keep responses concise.',
            tenantId: 'tenant-1',
        });
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
        const store = new InMemorySessionStore({
            now: () => new Date('2026-04-15T10:00:00.000Z'),
        });
        await store.set('stored-session', {
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
        }, {
            model: 'gpt-4o',
            provider: 'openai',
        });
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
    it('creates a fresh conversation when the session store has no record', async () => {
        const client = new LLMClient({
            sessionStore: new InMemorySessionStore(),
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
    it('applies a context manager before requests and preserves structured assistant content', async () => {
        const trim = vi.fn((messages) => messages.slice(1));
        const complete = vi.fn(async () => ({
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
        }));
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
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
        });
        const controller = new AbortController();
        await conversation.send([{ text: 'Newest question', type: 'text' }], {
            signal: controller.signal,
        });
        expect(trim).toHaveBeenCalled();
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({
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
        }));
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
        const complete = vi.fn(async () => ({
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
        }));
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
            contextManager: {
                shouldTrim: vi.fn(async () => true),
                trim: vi.fn(async (messages) => messages.slice(1)),
            },
            messages: [
                { content: 'Oldest', role: 'user' },
                { content: 'Newest context', role: 'assistant' },
            ],
        });
        await conversation.send('Latest');
        expect(complete).toHaveBeenCalledWith(expect.objectContaining({
            messages: [
                { content: 'Newest context', role: 'assistant' },
                { content: 'Latest', role: 'user' },
            ],
            sessionId: conversation.id,
        }));
    });
    it('passes through streamed error and tool-call-delta chunks while continuing the tool loop', async () => {
        const execute = vi.fn(async (args) => ({
            normalized: args.result ?? null,
        }));
        const stream = vi
            .fn()
            .mockImplementationOnce(async function* () {
            yield { error: new Error('intermediate warning'), type: 'error' };
            yield { argsDelta: '{"value":"Ber', id: 'tool_1', type: 'tool-call-delta' };
            yield {
                id: 'tool_1',
                name: 'lookup_weather',
                result: 'Berlin',
                type: 'tool-call-result',
            };
            yield {
                finishReason: 'tool_call',
                type: 'done',
                usage: usage(4, 1, 0.01),
            };
        })
            .mockImplementationOnce(async function* () {
            yield { delta: 'Done.', type: 'text-delta' };
            yield {
                finishReason: 'stop',
                type: 'done',
                usage: usage(2, 1, 0.01),
            };
        });
        const conversation = new Conversation({
            complete: vi.fn(),
            stream,
        }, {
            model: 'gpt-4o',
            tools: [buildTool('lookup_weather', execute)],
        });
        const chunks = [];
        for await (const chunk of conversation.sendStream('Run the tool.')) {
            chunks.push(chunk);
        }
        expect(chunks[0]).toEqual(expect.objectContaining({
            error: expect.any(Error),
            type: 'error',
        }));
        expect(chunks[1]).toEqual({
            argsDelta: '{"value":"Ber',
            id: 'tool_1',
            type: 'tool-call-delta',
        });
        expect(execute).toHaveBeenCalledWith({ result: 'Berlin' }, expect.objectContaining({
            sessionId: conversation.id,
        }));
    });
    it('returns structured errors when a called tool has no execute callback', async () => {
        const complete = vi
            .fn()
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
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
            model: 'gpt-4o',
            tools: [
                {
                    description: 'No execute callback',
                    name: 'missing_tool',
                    parameters: { type: 'object' },
                },
                buildTool('lookup_weather', vi.fn(async () => ({ ok: true }))),
            ],
        });
        await conversation.send('Use the missing tool.');
        expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
            messages: expect.arrayContaining([
                {
                    content: [
                        {
                            isError: true,
                            name: 'missing_tool',
                            result: {
                                error: {
                                    message: 'No executable tool registered for "missing_tool".',
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
        }));
    });
    it('returns timeout errors when tool execution exceeds the configured limit', async () => {
        const complete = vi
            .fn()
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
        const conversation = new Conversation({
            complete,
            stream: vi.fn(),
        }, {
            model: 'gpt-4o',
            toolExecutionTimeoutMs: 1,
            tools: [
                buildTool('slow_tool', vi.fn(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return { ok: true };
                })),
            ],
        });
        await conversation.send('Run the slow tool.');
        expect(complete).toHaveBeenNthCalledWith(2, expect.objectContaining({
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
        }));
    });
});
describe('SlidingWindowStrategy', () => {
    it('trims the oldest removable messages while preserving pinned and latest user content', () => {
        const strategy = new SlidingWindowStrategy({
            maxMessages: 2,
        });
        const messages = [
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
        const messages = [
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
        const messages = [
            { content: 'Pinned', pinned: true, role: 'assistant' },
            { content: 'Latest user', role: 'user' },
        ];
        expect(strategy.shouldTrim(messages, {})).toBe(true);
        expect(strategy.trim(messages, {})).toEqual(messages);
    });
    it('returns false from shouldTrim when no limits are configured', () => {
        const strategy = new SlidingWindowStrategy();
        expect(strategy.shouldTrim([{ content: 'Hello', role: 'user' }], {})).toBe(false);
    });
});
describe('SummarisationStrategy', () => {
    it('replaces older removable messages with a generated summary', async () => {
        const summarizer = vi.fn(async (messages) => {
            return `Summary of ${messages.length} messages`;
        });
        const strategy = new SummarisationStrategy({
            keepLastMessages: 1,
            maxMessages: 3,
            summarizer,
        });
        const messages = [
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
        const firstPass = await strategy.trim([
            { content: 'User one', role: 'user' },
            { content: 'Assistant one', role: 'assistant' },
            { content: 'User two', role: 'user' },
            { content: 'Assistant two', role: 'assistant' },
            { content: 'Latest user', role: 'user' },
        ], {});
        const secondPass = await strategy.trim([
            ...firstPass,
            { content: 'Assistant three', role: 'assistant' },
            { content: 'Newest user', role: 'user' },
        ], {});
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
        const store = new InMemorySessionStore({
            now: () => new Date('2026-04-15T12:00:00.000Z'),
        });
        await store.set('session-a', {
            messages: [{ role: 'user', content: 'Hello' }],
            totalCostUSD: 0.5,
        }, {
            model: 'gpt-4o',
            provider: 'openai',
            tenantId: 'tenant-1',
        });
        const record = await store.get('session-a', 'tenant-1');
        const list = await store.list({ tenantId: 'tenant-1' });
        await store.delete('session-a', 'tenant-1');
        expect(record?.meta.sessionId).toBe('session-a');
        expect(record?.meta.tenantId).toBe('tenant-1');
        expect(list).toHaveLength(1);
        expect(await store.get('session-a', 'tenant-1')).toBeNull();
    });
    it('returns null for missing records and preserves existing metadata on update', async () => {
        const store = new InMemorySessionStore({
            now: () => new Date('2026-04-15T13:00:00.000Z'),
        });
        expect(await store.get('missing')).toBeNull();
        await store.set('session-b', {
            messages: [{ role: 'user', content: 'Hello' }],
            totalCostUSD: 1,
        }, {
            createdAt: '2026-04-14T00:00:00.000Z',
            model: 'gpt-4o',
            provider: 'openai',
            tenantId: 'tenant-2',
        });
        const updated = await store.set('session-b', {
            messages: [{ role: 'assistant', content: 'Updated' }],
            totalCostUSD: 2,
        }, {
            tenantId: 'tenant-2',
        });
        expect(updated.meta.createdAt).toBe('2026-04-14T00:00:00.000Z');
        expect(updated.meta.model).toBe('gpt-4o');
        expect(updated.meta.provider).toBe('openai');
        expect(updated.meta.tenantId).toBe('tenant-2');
        expect(updated.meta.messageCount).toBe(1);
        expect(updated.meta.totalCostUSD).toBe(2);
    });
});
function buildTool(name, execute) {
    return {
        description: `Tool ${name}`,
        execute,
        name,
        parameters: {
            properties: {
                city: { type: 'string' },
            },
            type: 'object',
        },
    };
}
function usage(inputTokens, outputTokens, costUSD) {
    return {
        cachedTokens: 0,
        cost: `$${costUSD.toFixed(2)}`,
        costUSD,
        inputTokens,
        outputTokens,
    };
}
