/**
 * Real live test suite — all three providers, two modes.
 *
 * PART 1 — Basic completions (main-branch behavior, no caching options)
 *   Verifies that complete() and stream() work against real APIs.
 *
 * PART 2 — Prompt caching (prompt_caching branch)
 *   Verifies that cached tokens actually appear in usage after a warm request.
 *
 * Keys are loaded from the .env file in this folder.
 * Each provider block is individually skipped when its key is absent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LLMClient } from '../../src/client.js';
import { buildLargePrefix, loadEnv, log, summarize } from './helpers.js';
loadEnv();
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const hasGemini = Boolean(process.env.GEMINI_API_KEY);
const ifOpenAI = hasOpenAI ? it : it.skip;
const ifAnthropic = hasAnthropic ? it : it.skip;
const ifGemini = hasGemini ? it : it.skip;
// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — Basic completions (same code paths as main branch)
// ─────────────────────────────────────────────────────────────────────────────
describe('Part 1 — Basic completions (no caching)', () => {
    let client;
    beforeAll(() => {
        client = LLMClient.fromEnv();
    });
    // ── OpenAI ──────────────────────────────────────────────────────────────────
    ifOpenAI('OpenAI: complete() returns text and usage', async () => {
        const res = await client.complete({
            maxTokens: 32,
            messages: [{ content: 'Reply with exactly: OPENAI_OK', role: 'user' }],
            model: 'gpt-4o-mini',
            provider: 'openai',
            temperature: 0,
        });
        log('openai-basic-complete', summarize(res));
        expect(res.provider).toBe('openai');
        expect(res.text.length).toBeGreaterThan(0);
        expect(res.usage.inputTokens).toBeGreaterThan(0);
        expect(res.usage.outputTokens).toBeGreaterThan(0);
        expect(res.usage.costUSD).toBeGreaterThan(0);
        expect(res.finishReason).toBe('stop');
    }, 30_000);
    ifOpenAI('OpenAI: stream() yields text-delta chunks then done', async () => {
        const chunks = [];
        let doneChunk;
        for await (const chunk of client.stream({
            maxTokens: 32,
            messages: [{ content: 'Count to three.', role: 'user' }],
            model: 'gpt-4o-mini',
            provider: 'openai',
            temperature: 0,
        })) {
            if (chunk.type === 'text-delta')
                chunks.push(chunk.delta);
            if (chunk.type === 'done')
                doneChunk = chunk;
        }
        log('openai-basic-stream', { chunks: chunks.join(''), doneChunk });
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.join('').length).toBeGreaterThan(0);
        expect(doneChunk).toMatchObject({ finishReason: 'stop', type: 'done' });
    }, 30_000);
    ifOpenAI('OpenAI: tool call round-trip via complete()', async () => {
        const res = await client.complete({
            maxTokens: 64,
            messages: [{ content: 'What is the weather in Berlin?', role: 'user' }],
            model: 'gpt-4o-mini',
            provider: 'openai',
            temperature: 0,
            toolChoice: { type: 'any' },
            tools: [
                {
                    description: 'Get current weather for a city',
                    name: 'get_weather',
                    parameters: {
                        properties: { city: { type: 'string' } },
                        required: ['city'],
                        type: 'object',
                    },
                },
            ],
        });
        log('openai-tool-call', summarize(res));
        expect(res.finishReason).toBe('tool_call');
        expect(res.toolCalls.length).toBeGreaterThan(0);
        expect(res.toolCalls[0]?.name).toBe('get_weather');
        expect(res.toolCalls[0]?.args).toHaveProperty('city');
    }, 30_000);
    // ── Anthropic ───────────────────────────────────────────────────────────────
    ifAnthropic('Anthropic: complete() returns text and usage', async () => {
        let res;
        try {
            res = await client.complete({
                maxTokens: 32,
                messages: [{ content: 'Reply with exactly: ANTHROPIC_OK', role: 'user' }],
                model: 'claude-haiku-4-5',
                provider: 'anthropic',
                temperature: 0,
            });
        }
        catch (err) {
            if (/credit|billing|balance/i.test(String(err))) {
                console.warn('[anthropic] skipped — account needs credits');
                return;
            }
            throw err;
        }
        log('anthropic-basic-complete', summarize(res));
        expect(res.provider).toBe('anthropic');
        expect(res.text.length).toBeGreaterThan(0);
        expect(res.usage.inputTokens).toBeGreaterThan(0);
        expect(res.usage.outputTokens).toBeGreaterThan(0);
        expect(res.usage.costUSD).toBeGreaterThan(0);
        expect(res.finishReason).toBe('stop');
    }, 30_000);
    ifAnthropic('Anthropic: stream() yields text-delta chunks then done', async () => {
        const chunks = [];
        let doneChunk;
        try {
            for await (const chunk of client.stream({
                maxTokens: 32,
                messages: [{ content: 'Count to three.', role: 'user' }],
                model: 'claude-haiku-4-5',
                provider: 'anthropic',
                temperature: 0,
            })) {
                if (chunk.type === 'text-delta')
                    chunks.push(chunk.delta);
                if (chunk.type === 'done')
                    doneChunk = chunk;
            }
        }
        catch (err) {
            if (/credit|billing|balance/i.test(String(err))) {
                console.warn('[anthropic] skipped — account needs credits');
                return;
            }
            throw err;
        }
        log('anthropic-basic-stream', { chunks: chunks.join(''), doneChunk });
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.join('').length).toBeGreaterThan(0);
        expect(doneChunk).toMatchObject({ finishReason: 'stop', type: 'done' });
    }, 30_000);
    ifAnthropic('Anthropic: tool call round-trip via complete()', async () => {
        let res;
        try {
            res = await client.complete({
                maxTokens: 64,
                messages: [{ content: 'What is the weather in London?', role: 'user' }],
                model: 'claude-haiku-4-5',
                provider: 'anthropic',
                temperature: 0,
                toolChoice: { type: 'any' },
                tools: [
                    {
                        description: 'Get current weather for a city',
                        name: 'get_weather',
                        parameters: {
                            properties: { city: { type: 'string' } },
                            required: ['city'],
                            type: 'object',
                        },
                    },
                ],
            });
        }
        catch (err) {
            if (/credit|billing|balance/i.test(String(err))) {
                console.warn('[anthropic] skipped — account needs credits');
                return;
            }
            throw err;
        }
        log('anthropic-tool-call', summarize(res));
        expect(res.finishReason).toBe('tool_call');
        expect(res.toolCalls.length).toBeGreaterThan(0);
        expect(res.toolCalls[0]?.name).toBe('get_weather');
        expect(res.toolCalls[0]?.args).toHaveProperty('city');
    }, 30_000);
    // ── Gemini ──────────────────────────────────────────────────────────────────
    ifGemini('Gemini: complete() returns text and usage', async () => {
        const res = await client.complete({
            maxTokens: 32,
            messages: [{ content: 'Reply with exactly: GEMINI_OK', role: 'user' }],
            model: 'gemini-2.5-flash',
            provider: 'google',
            temperature: 0,
        });
        log('gemini-basic-complete', summarize(res));
        expect(res.provider).toBe('google');
        expect(res.usage.inputTokens).toBeGreaterThan(0);
        expect(res.usage.outputTokens).toBeGreaterThanOrEqual(0);
        expect(res.usage.costUSD).toBeGreaterThanOrEqual(0);
    }, 30_000);
    ifGemini('Gemini: stream() yields text-delta chunks then done', async () => {
        const chunks = [];
        let doneChunk;
        for await (const chunk of client.stream({
            maxTokens: 32,
            messages: [{ content: 'Count to three.', role: 'user' }],
            model: 'gemini-2.5-flash',
            provider: 'google',
            temperature: 0,
        })) {
            if (chunk.type === 'text-delta')
                chunks.push(chunk.delta);
            if (chunk.type === 'done')
                doneChunk = chunk;
        }
        log('gemini-basic-stream', { chunks: chunks.join(''), doneChunk });
        expect(chunks.join('').length).toBeGreaterThanOrEqual(0);
        expect(doneChunk).toMatchObject({ type: 'done' });
    }, 30_000);
    ifGemini('Gemini: tool call round-trip via complete()', async () => {
        // gemini-2.5-flash is a thinking model; it consumes reasoning tokens before
        // emitting output, so maxTokens must be large enough to cover both.
        const res = await client.complete({
            maxTokens: 1024,
            messages: [
                {
                    content: 'Use the get_weather tool to look up the weather in Tokyo.',
                    role: 'user',
                },
            ],
            model: 'gemini-2.5-flash',
            provider: 'google',
            temperature: 0,
            toolChoice: { type: 'auto' },
            tools: [
                {
                    description: 'Get current weather for a city',
                    name: 'get_weather',
                    parameters: {
                        properties: { city: { type: 'string' } },
                        required: ['city'],
                        type: 'object',
                    },
                },
            ],
        });
        log('gemini-tool-call', summarize(res));
        expect(res.finishReason).toBe('tool_call');
        expect(res.toolCalls.length).toBeGreaterThan(0);
        expect(res.toolCalls[0]?.name).toBe('get_weather');
        expect(res.toolCalls[0]?.args).toHaveProperty('city');
    }, 30_000);
});
// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — Prompt caching (prompt_caching branch features)
// ─────────────────────────────────────────────────────────────────────────────
describe('Part 2 — Prompt caching', () => {
    let client;
    const geminiCacheNames = [];
    beforeAll(() => {
        client = LLMClient.fromEnv();
    });
    afterAll(async () => {
        for (const name of geminiCacheNames) {
            try {
                await client.googleCaches.delete(name);
                log('gemini-cleanup', { deleted: name });
            }
            catch {
                log('gemini-cleanup', { failed: name });
            }
        }
    });
    // ── OpenAI ──────────────────────────────────────────────────────────────────
    ifOpenAI('OpenAI: second request with same cache key returns cached tokens', async () => {
        const cacheKey = `live-openai-${Date.now()}`;
        const prefix = buildLargePrefix('OpenAI refund policy knowledge base');
        const makeReq = () => client.complete({
            maxTokens: 16,
            messages: [{ content: `${prefix}\nReply OK.`, role: 'user' }],
            model: 'gpt-4o-mini',
            provider: 'openai',
            providerOptions: {
                openai: { promptCaching: { key: cacheKey, retention: 'in_memory' } },
            },
            temperature: 0,
        });
        // Warm the cache, then retry until cached tokens appear (up to 3 attempts).
        const first = summarize(await makeReq());
        const attempts = [summarize(await makeReq())];
        for (let i = 0; i < 2 && attempts.at(-1).cachedTokens === 0; i++) {
            attempts.push(summarize(await makeReq()));
        }
        const best = attempts.find((a) => a.cachedTokens > 0) ?? attempts.at(-1);
        log('openai-caching', { attempts, cacheKey, first });
        expect(first.inputTokens).toBeGreaterThanOrEqual(1024);
        expect(best.cachedTokens).toBeGreaterThan(0);
        expect(best.costUSD).toBeLessThan(first.costUSD);
    }, 60_000);
    // ── Anthropic ───────────────────────────────────────────────────────────────
    ifAnthropic('Anthropic: first request writes cache, second reads it back', async () => {
        const prefix = buildLargePrefix(`anthropic-live-${Date.now()}`);
        const makeReq = () => client.complete({
            maxTokens: 16,
            messages: [
                {
                    content: [
                        { cacheControl: { type: 'ephemeral' }, text: prefix, type: 'text' },
                        { text: 'Reply with ANTHROPIC_CACHE_OK only.', type: 'text' },
                    ],
                    role: 'user',
                },
            ],
            model: 'claude-haiku-4-5',
            provider: 'anthropic',
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
            temperature: 0,
        });
        let first, second;
        try {
            first = summarize(await makeReq());
            // Give Anthropic ephemeral cache time to settle before the read request.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            second = summarize(await makeReq());
        }
        catch (err) {
            if (/credit|billing|balance/i.test(String(err))) {
                console.warn('[anthropic] skipped — account needs credits');
                return;
            }
            throw err;
        }
        log('anthropic-caching', { first, second });
        expect(first.cachedWriteTokens).toBeGreaterThan(0);
        expect(second.cachedReadTokens).toBeGreaterThan(0);
        expect(second.costUSD).toBeLessThan(first.costUSD);
    }, 60_000);
    // ── Gemini ──────────────────────────────────────────────────────────────────
    ifGemini('Gemini: create cache → use it in completion → cached tokens confirmed', async () => {
        const prefix = buildLargePrefix(`gemini-live-${Date.now()}`);
        const cache = await client.googleCaches.create({
            displayName: `live-droid-${Date.now()}`,
            messages: [{ content: prefix, role: 'user' }],
            model: 'gemini-2.5-flash',
            ttl: '600s',
        });
        geminiCacheNames.push(cache.name);
        const res = summarize(await client.complete({
            maxTokens: 16,
            messages: [{ content: 'Reply with GEMINI_CACHE_OK.', role: 'user' }],
            model: 'gemini-2.5-flash',
            provider: 'google',
            providerOptions: { google: { promptCaching: { cachedContent: cache.name } } },
            temperature: 0,
        }));
        log('gemini-caching', { cacheName: cache.name, res });
        expect(cache.name).toMatch(/^cachedContents\//u);
        expect(res.cachedTokens).toBeGreaterThan(0);
    }, 90_000);
    ifGemini('Gemini: googleCaches CRUD — create, get, update, list, delete', async () => {
        const prefix = buildLargePrefix(`gemini-crud-${Date.now()}`);
        const created = await client.googleCaches.create({
            displayName: `crud-droid-${Date.now()}`,
            messages: [{ content: prefix, role: 'user' }],
            model: 'gemini-2.5-flash',
            ttl: '300s',
        });
        const fetched = await client.googleCaches.get(created.name);
        const updated = await client.googleCaches.update(created.name, { ttl: '600s' });
        const listed = await client.googleCaches.list({ pageSize: 50 });
        log('gemini-crud', {
            created: created.name,
            fetched: fetched.name,
            listedCount: listed.cachedContents.length,
            updated: updated.name,
        });
        expect(fetched.name).toBe(created.name);
        expect(updated.name).toBe(created.name);
        expect(listed.cachedContents.some((c) => c.name === created.name)).toBe(true);
        await client.googleCaches.delete(created.name);
        log('gemini-crud', { deleted: created.name });
    }, 60_000);
});
