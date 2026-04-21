import { afterAll, describe, expect, it } from 'vitest';
import { LLMClient } from '../../src/client.js';
import { buildCachedPrefix, loadPromptCachingEnv, logPromptCachingResult, summarizeResponse, } from './helpers.js';
loadPromptCachingEnv();
const liveEnabled = process.env.LIVE_TESTS === '1';
const liveDescribe = liveEnabled ? describe : describe.skip;
function liveIt(enabled) {
    return enabled ? it : it.skip;
}
liveDescribe('prompt caching live', () => {
    const cleanup = [];
    afterAll(async () => {
        for (const action of cleanup.reverse()) {
            await action();
        }
    });
    liveIt(Boolean(process.env.OPENAI_API_KEY))('warms and reuses OpenAI prompt caching', async () => {
        const client = LLMClient.fromEnv();
        const cacheKey = `live-openai-cache-${Date.now()}`;
        const cachedPrefix = buildCachedPrefix('OpenAI prompt cache validation');
        const attempts = [];
        for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
            const response = await client.complete({
                maxTokens: 32,
                messages: [
                    {
                        content: `${cachedPrefix}\nReply with exactly OPENAI_PROMPT_CACHE_OK.`,
                        role: 'user',
                    },
                ],
                model: 'gpt-4o-mini',
                provider: 'openai',
                providerOptions: {
                    openai: {
                        promptCaching: {
                            key: cacheKey,
                            retention: 'in_memory',
                        },
                    },
                },
                temperature: 0,
            });
            attempts.push(summarizeResponse(response));
            if (attemptIndex > 0 && response.usage.cachedTokens > 0) {
                break;
            }
        }
        logPromptCachingResult('openai', { attempts, cacheKey });
        expect(attempts[0]?.inputTokens ?? 0).toBeGreaterThanOrEqual(1024);
        expect(attempts.some((attempt, index) => index > 0 && attempt.cachedTokens > 0)).toBe(true);
    }, 45_000);
    liveIt(Boolean(process.env.ANTHROPIC_API_KEY))('writes and reads Anthropic prompt cache entries', async () => {
        const client = LLMClient.fromEnv();
        const runId = `anthropic-cache-${Date.now()}`;
        const cachedPolicy = buildCachedPrefix(`Anthropic cache policy excerpt ${runId}`);
        const request = () => client.complete({
            maxTokens: 32,
            messages: [
                {
                    content: [
                        {
                            cacheControl: { type: 'ephemeral' },
                            text: cachedPolicy,
                            type: 'text',
                        },
                        {
                            text: 'Reply with exactly ANTHROPIC_PROMPT_CACHE_OK.',
                            type: 'text',
                        },
                    ],
                    role: 'user',
                },
            ],
            model: 'claude-haiku-4-5',
            provider: 'anthropic',
            providerOptions: {
                anthropic: {
                    cacheControl: { type: 'ephemeral' },
                },
            },
            temperature: 0,
        });
        const first = summarizeResponse(await request());
        const second = summarizeResponse(await request());
        logPromptCachingResult('anthropic', { first, second });
        expect(first.cachedWriteTokens).toBeGreaterThan(0);
        expect(second.cachedReadTokens).toBeGreaterThan(0);
    }, 45_000);
    liveIt(Boolean(process.env.GEMINI_API_KEY))('creates, reuses, updates, lists, and deletes a Gemini cache', async () => {
        const client = LLMClient.fromEnv();
        const cache = await client.googleCaches.create({
            displayName: `live-cache-${Date.now()}`,
            messages: [
                {
                    content: buildCachedPrefix('Gemini support knowledge base'),
                    role: 'user',
                },
            ],
            model: 'gemini-2.5-flash',
            ttl: '600s',
        });
        cleanup.push(async () => {
            try {
                await client.googleCaches.delete(cache.name);
            }
            catch {
                return;
            }
        });
        const fetched = await client.googleCaches.get(cache.name);
        const updated = await client.googleCaches.update(cache.name, {
            ttl: '900s',
        });
        const listed = await client.googleCaches.list({ pageSize: 100 });
        const response = await client.complete({
            maxTokens: 32,
            messages: [
                {
                    content: 'Reply with exactly GEMINI_PROMPT_CACHE_OK.',
                    role: 'user',
                },
            ],
            model: 'gemini-2.5-flash',
            provider: 'google',
            providerOptions: {
                google: {
                    promptCaching: {
                        cachedContent: cache.name,
                    },
                },
            },
            temperature: 0,
        });
        const summary = summarizeResponse(response);
        logPromptCachingResult('gemini', {
            cacheName: cache.name,
            listed: listed.cachedContents.some((item) => item.name === cache.name),
            response: summary,
        });
        expect(cache.name).toMatch(/^cachedContents\//u);
        expect(fetched.name).toBe(cache.name);
        expect(updated.name).toBe(cache.name);
        expect(listed.cachedContents.some((item) => item.name === cache.name)).toBe(true);
        expect(summary.cachedTokens).toBeGreaterThan(0);
    }, 45_000);
});
