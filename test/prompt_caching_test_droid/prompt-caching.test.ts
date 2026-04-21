/**
 * Prompt-caching test suite covering all three providers.
 *
 * Unit tests (no API keys): verify the adapters produce correct request shapes.
 * Live tests (LIVE_TESTS=1): hit real APIs and confirm cached tokens appear.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LLMClient } from '../../src/client.js';
import { translateAnthropicRequest } from '../../src/providers/anthropic.js';
import {
  translateGeminiCacheCreateRequest,
  translateGeminiRequest,
} from '../../src/providers/gemini.js';
import { translateOpenAIRequest } from '../../src/providers/openai.js';

import { buildLargePrefix, loadEnv, log, summarize } from './helpers.js';

// ─── env ──────────────────────────────────────────────────────────────────────

loadEnv();

const live = process.env.LIVE_TESTS === '1';
const liveDescribe = live ? describe : describe.skip;

// ─── OpenAI ───────────────────────────────────────────────────────────────────

describe('OpenAI – prompt caching (unit)', () => {
  it('adds prompt_cache_key and prompt_cache_retention when providerOptions are supplied', () => {
    const body = translateOpenAIRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o-mini',
      providerOptions: {
        openai: {
          promptCaching: {
            key: 'my-cache-key',
            retention: '24h',
          },
        },
      },
    });

    expect(body).toMatchObject({
      prompt_cache_key: 'my-cache-key',
      prompt_cache_retention: '24h',
      store: false,
    });
  });

  it('accepts in_memory as a valid retention value', () => {
    const body = translateOpenAIRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o-mini',
      providerOptions: {
        openai: { promptCaching: { key: 'session-key', retention: 'in_memory' } },
      },
    });

    expect(body.prompt_cache_retention).toBe('in_memory');
  });

  it('omits caching fields when no providerOptions are set', () => {
    const body = translateOpenAIRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o-mini',
    });

    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('prompt_cache_retention');
  });

  it('omits caching fields when only key is absent', () => {
    const body = translateOpenAIRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gpt-4o-mini',
      providerOptions: {
        openai: { promptCaching: { retention: '24h' } },
      },
    });

    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body.prompt_cache_retention).toBe('24h');
  });

  it('still sends store:false and correct input shape alongside caching fields', () => {
    const body = translateOpenAIRequest({
      messages: [
        { content: 'Be helpful.', role: 'system' },
        { content: 'What is 2+2?', role: 'user' },
      ],
      model: 'gpt-4o-mini',
      providerOptions: {
        openai: { promptCaching: { key: 'math-cache', retention: 'in_memory' } },
      },
    });

    expect(body.store).toBe(false);
    expect(body.instructions).toBe('Be helpful.');
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.prompt_cache_key).toBe('math-cache');
  });
});

liveDescribe('OpenAI – prompt caching (live)', () => {
  it(
    'warms a cache key and observes cached tokens on the second request',
    async () => {
      const client = LLMClient.fromEnv();
      const cacheKey = `droid-openai-${Date.now()}`;
      const prefix = buildLargePrefix('OpenAI support knowledge base');
      const attempts: ReturnType<typeof summarize>[] = [];

      for (let i = 0; i < 3; i++) {
        const res = await client.complete({
          maxTokens: 32,
          messages: [
            {
              content: `${prefix}\nReply with OPENAI_CACHE_OK only.`,
              role: 'user',
            },
          ],
          model: 'gpt-4o-mini',
          provider: 'openai',
          providerOptions: {
            openai: { promptCaching: { key: cacheKey, retention: 'in_memory' } },
          },
          temperature: 0,
        });

        attempts.push(summarize(res));
        if (i > 0 && res.usage.cachedTokens > 0) {
          break;
        }
      }

      log('openai', { attempts, cacheKey });

      expect(attempts[0]?.inputTokens).toBeGreaterThanOrEqual(1024);
      expect(
        attempts.some((a, idx) => idx > 0 && a.cachedTokens > 0),
      ).toBe(true);
    },
    60_000,
  );
});

// ─── Anthropic ────────────────────────────────────────────────────────────────

describe('Anthropic – prompt caching (unit)', () => {
  it('adds top-level cache_control when providerOptions.anthropic.cacheControl is set', () => {
    const body = translateAnthropicRequest({
      maxTokens: 64,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'claude-haiku-4-5',
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    });

    expect(body).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('omits cache_control when no providerOptions are set', () => {
    const body = translateAnthropicRequest({
      maxTokens: 64,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'claude-haiku-4-5',
    });

    expect(body).not.toHaveProperty('cache_control');
  });

  it('forwards per-part cacheControl to the anthropic text block', () => {
    const body = translateAnthropicRequest({
      maxTokens: 64,
      messages: [
        {
          content: [
            {
              cacheControl: { type: 'ephemeral' },
              text: 'Large policy document…',
              type: 'text',
            },
            {
              text: 'What is the refund policy?',
              type: 'text',
            },
          ],
          role: 'user',
        },
      ],
      model: 'claude-haiku-4-5',
    });

    const messages = body.messages as Array<{
      content: Array<{ cache_control?: { type: string }; text: string; type: string }>;
    }>;
    const firstPart = messages[0]?.content[0];
    const secondPart = messages[0]?.content[1];

    expect(firstPart?.cache_control).toEqual({ type: 'ephemeral' });
    expect(secondPart).not.toHaveProperty('cache_control');
  });

  it('forwards cacheControl on tool definitions', () => {
    const body = translateAnthropicRequest({
      maxTokens: 64,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'claude-haiku-4-5',
      tools: [
        {
          cacheControl: { type: 'ephemeral' },
          description: 'Lookup weather',
          name: 'get_weather',
          parameters: { type: 'object' },
        },
      ],
    });

    const tools = body.tools as Array<{ cache_control?: { type: string }; name: string }>;
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits cache_control on tool definitions when not set', () => {
    const body = translateAnthropicRequest({
      maxTokens: 64,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'claude-haiku-4-5',
      tools: [
        {
          description: 'Lookup weather',
          name: 'get_weather',
          parameters: { type: 'object' },
        },
      ],
    });

    const tools = body.tools as Array<{ cache_control?: unknown }>;
    expect(tools[0]).not.toHaveProperty('cache_control');
  });
});

liveDescribe('Anthropic – prompt caching (live)', () => {
  it(
    'writes a cache entry on first request and reads it on the second',
    async () => {
      const client = LLMClient.fromEnv();
      const prefix = buildLargePrefix(`anthropic-droid-${Date.now()}`);

      const makeRequest = () =>
        client.complete({
          maxTokens: 32,
          messages: [
            {
              content: [
                {
                  cacheControl: { type: 'ephemeral' },
                  text: prefix,
                  type: 'text',
                },
                {
                  text: 'Reply with ANTHROPIC_CACHE_OK only.',
                  type: 'text',
                },
              ],
              role: 'user',
            },
          ],
          model: 'claude-haiku-4-5',
          provider: 'anthropic',
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
          temperature: 0,
        });

      let first: ReturnType<typeof summarize>;
      let second: ReturnType<typeof summarize>;

      try {
        first = summarize(await makeRequest());
        second = summarize(await makeRequest());
      } catch (err) {
        const msg = String(err);
        if (/credit|billing|balance/i.test(msg)) {
          console.warn('[anthropic-live] skipped — account needs credits:', msg);
          return;
        }
        throw err;
      }

      log('anthropic', { first, second });

      expect(first.cachedWriteTokens).toBeGreaterThan(0);
      expect(second.cachedReadTokens).toBeGreaterThan(0);
      expect(second.cachedReadTokens).toBeGreaterThan(first.cachedReadTokens);
    },
    60_000,
  );
});

// ─── Gemini ───────────────────────────────────────────────────────────────────

describe('Gemini – prompt caching (unit)', () => {
  it('adds cachedContent to the request body when providerOptions.google.promptCaching is set', () => {
    const body = translateGeminiRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gemini-2.5-flash',
      providerOptions: {
        google: { promptCaching: { cachedContent: 'cachedContents/abc123' } },
      },
    });

    expect(body).toMatchObject({ cachedContent: 'cachedContents/abc123' });
  });

  it('omits cachedContent when no providerOptions are set', () => {
    const body = translateGeminiRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gemini-2.5-flash',
    });

    expect(body).not.toHaveProperty('cachedContent');
  });

  it('produces a valid cache-create request shape', () => {
    const body = translateGeminiCacheCreateRequest({
      displayName: 'my-cache',
      messages: [
        { content: 'System instructions here.', role: 'user' },
      ],
      model: 'gemini-2.5-flash',
      ttl: '600s',
    });

    expect(body).toMatchObject({
      displayName: 'my-cache',
      model: expect.stringContaining('gemini'),
      ttl: '600s',
    });
    expect(Array.isArray((body as { contents: unknown[] }).contents)).toBe(true);
  });

  it('omits displayName from cache-create request when not provided', () => {
    const body = translateGeminiCacheCreateRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gemini-2.5-flash',
      ttl: '300s',
    });

    expect(body).not.toHaveProperty('displayName');
    expect(body).toMatchObject({ ttl: '300s' });
  });

  it('omits cachedContent when an empty string is given', () => {
    const body = translateGeminiRequest({
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'gemini-2.5-flash',
      providerOptions: {
        google: { promptCaching: { cachedContent: '' } },
      },
    });

    expect(body).not.toHaveProperty('cachedContent');
  });
});

liveDescribe('Gemini – prompt caching (live)', () => {
  let cacheName: string | undefined;
  let client: LLMClient;

  beforeAll(() => {
    client = LLMClient.fromEnv();
  });

  afterAll(async () => {
    if (cacheName) {
      try {
        await client.googleCaches.delete(cacheName);
        log('gemini', { action: 'cleanup', deleted: cacheName });
      } catch {
        log('gemini', { action: 'cleanup-failed', cacheName });
      }
    }
  });

  it(
    'creates a cache, reads it back, updates TTL, lists it, and uses it in a completion',
    async () => {
      const prefix = buildLargePrefix(`gemini-droid-${Date.now()}`);

      // Create
      const created = await client.googleCaches.create({
        displayName: `droid-cache-${Date.now()}`,
        messages: [{ content: prefix, role: 'user' }],
        model: 'gemini-2.5-flash',
        ttl: '600s',
      });
      cacheName = created.name;
      expect(created.name).toMatch(/^cachedContents\//u);

      // Get
      const fetched = await client.googleCaches.get(created.name);
      expect(fetched.name).toBe(created.name);

      // Update TTL
      const updated = await client.googleCaches.update(created.name, { ttl: '900s' });
      expect(updated.name).toBe(created.name);

      // List
      const listed = await client.googleCaches.list({ pageSize: 50 });
      expect(listed.cachedContents.some((c) => c.name === created.name)).toBe(true);

      // Use in completion
      const res = await client.complete({
        maxTokens: 32,
        messages: [{ content: 'Reply with GEMINI_CACHE_OK only.', role: 'user' }],
        model: 'gemini-2.5-flash',
        provider: 'google',
        providerOptions: {
          google: { promptCaching: { cachedContent: created.name } },
        },
        temperature: 0,
      });
      const summary = summarize(res);

      log('gemini', {
        cacheName: created.name,
        listed: listed.cachedContents.length,
        response: summary,
      });

      expect(summary.cachedTokens).toBeGreaterThan(0);
    },
    90_000,
  );
});

// ─── Cross-provider (live only) ───────────────────────────────────────────────

liveDescribe('Cross-provider – all three caches in one run (live)', () => {
  it(
    'confirms each provider independently reports cached tokens',
    async () => {
      const client = LLMClient.fromEnv();
      const prefix = buildLargePrefix('cross-provider-droid');
      const results: Record<string, { cachedTokens: number; provider: string }> = {};

      const skipped: string[] = [];

      // OpenAI
      if (process.env.OPENAI_API_KEY) {
        try {
          const cacheKey = `cross-openai-${Date.now()}`;
          await client.complete({
            maxTokens: 16,
            messages: [{ content: `${prefix}\nReply OK.`, role: 'user' }],
            model: 'gpt-4o-mini',
            providerOptions: { openai: { promptCaching: { key: cacheKey, retention: 'in_memory' } } },
            temperature: 0,
          });
          const second = summarize(
            await client.complete({
              maxTokens: 16,
              messages: [{ content: `${prefix}\nReply OK.`, role: 'user' }],
              model: 'gpt-4o-mini',
              providerOptions: { openai: { promptCaching: { key: cacheKey, retention: 'in_memory' } } },
              temperature: 0,
            }),
          );
          results.openai = { cachedTokens: second.cachedTokens, provider: 'openai' };
        } catch (err) {
          skipped.push(`openai: ${String(err)}`);
        }
      }

      // Anthropic
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          const makeReq = () =>
            client.complete({
              maxTokens: 16,
              messages: [
                {
                  content: [
                    { cacheControl: { type: 'ephemeral' }, text: prefix, type: 'text' },
                    { text: 'Reply OK.', type: 'text' },
                  ],
                  role: 'user',
                },
              ],
              model: 'claude-haiku-4-5',
              provider: 'anthropic',
              providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
              temperature: 0,
            });
          await makeReq();
          const second = summarize(await makeReq());
          results.anthropic = { cachedTokens: second.cachedReadTokens, provider: 'anthropic' };
        } catch (err) {
          skipped.push(`anthropic: ${String(err)}`);
        }
      }

      // Gemini
      let geminiCacheName: string | undefined;
      if (process.env.GEMINI_API_KEY) {
        try {
          const cache = await client.googleCaches.create({
            displayName: `cross-gemini-${Date.now()}`,
            messages: [{ content: prefix, role: 'user' }],
            model: 'gemini-2.5-flash',
            ttl: '300s',
          });
          geminiCacheName = cache.name;
          const res = summarize(
            await client.complete({
              maxTokens: 16,
              messages: [{ content: 'Reply OK.', role: 'user' }],
              model: 'gemini-2.5-flash',
              providerOptions: { google: { promptCaching: { cachedContent: cache.name } } },
              temperature: 0,
            }),
          );
          results.gemini = { cachedTokens: res.cachedTokens, provider: 'google' };
        } catch (err) {
          skipped.push(`gemini: ${String(err)}`);
        }
      }

      log('cross-provider', { results, skipped });

      // Cleanup Gemini cache
      if (geminiCacheName) {
        try {
          await client.googleCaches.delete(geminiCacheName);
        } catch {
          // best-effort
        }
      }

      if (skipped.length > 0) {
        console.warn('[cross-provider] some providers skipped:', skipped);
      }

      const providers = Object.keys(results);
      expect(providers.length, 'At least one provider must succeed').toBeGreaterThanOrEqual(1);
      for (const [name, r] of Object.entries(results)) {
        expect(r.cachedTokens, `${name} should have cached tokens`).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});
