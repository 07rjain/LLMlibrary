import { describe, expect, it, vi } from 'vitest';

import { calcCostUSD, formatCost } from '../src/utils/cost.js';
import { estimateMessageTokens } from '../src/utils/token-estimator.js';
import { withRetry, parseRetryAfterMs, parseGeminiRetryDelayMs } from '../src/utils/retry.js';
import { parseSSE } from '../src/utils/parse-sse.js';
import { ModelRegistry } from '../src/models/registry.js';

describe('Utility Functions', () => {
  describe('Cost Calculation', () => {
    const modelRegistry = new ModelRegistry();

    it('should calculate cost for known models', () => {
      const cost = calcCostUSD(
        {
          inputTokens: 1000,
          model: 'gpt-4o',
          outputTokens: 500,
        },
        modelRegistry,
      );

      expect(cost).toBeGreaterThan(0);
      expect(typeof cost).toBe('number');
    });

    it('should include cached tokens in calculation', () => {
      const costWithCache = calcCostUSD(
        {
          cachedReadTokens: 500,
          inputTokens: 1000,
          model: 'gpt-4o',
          outputTokens: 500,
        },
        modelRegistry,
      );

      const costWithoutCache = calcCostUSD(
        {
          inputTokens: 1000,
          model: 'gpt-4o',
          outputTokens: 500,
        },
        modelRegistry,
      );

      expect(costWithCache).toBeGreaterThan(costWithoutCache);
    });

    it('should return 0 for zero tokens', () => {
      const cost = calcCostUSD(
        {
          inputTokens: 0,
          model: 'gpt-4o',
          outputTokens: 0,
        },
        modelRegistry,
      );

      expect(cost).toBe(0);
    });

    it('should format cost as USD string', () => {
      expect(formatCost(0)).toBe('$0.00');
      expect(formatCost(0.001)).toBe('$0.0010');
      expect(formatCost(0.0001)).toBe('$0.0001');
      expect(formatCost(1.5)).toBe('$1.50');
      expect(formatCost(123.456789)).toBe('$123.46');
    });

    it('should handle very small costs', () => {
      expect(formatCost(0.00001)).toBe('$0.0000');
      expect(formatCost(0.000001)).toBe('$0.0000');
    });
  });

  describe('Token Estimation', () => {
    it('should estimate tokens for simple string messages', () => {
      const messages = [
        { content: 'Hello, how are you?', role: 'user' as const },
      ];

      const tokens = estimateMessageTokens(messages);

      expect(tokens).toBeGreaterThan(0);
      expect(typeof tokens).toBe('number');
    });

    it('should estimate tokens for multipart messages', () => {
      const messages = [
        {
          content: [
            { text: 'Hello', type: 'text' as const },
            { text: 'World', type: 'text' as const },
          ],
          role: 'user' as const,
        },
      ];

      const tokens = estimateMessageTokens(messages);

      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle empty messages', () => {
      const tokens = estimateMessageTokens([]);
      expect(tokens).toBe(0);
    });

    it('should estimate more tokens for longer content', () => {
      const shortMessages = [{ content: 'Hi', role: 'user' as const }];
      const longMessages = [
        {
          content: 'This is a much longer message that should result in more tokens being estimated',
          role: 'user' as const,
        },
      ];

      const shortTokens = estimateMessageTokens(shortMessages);
      const longTokens = estimateMessageTokens(longMessages);

      expect(longTokens).toBeGreaterThan(shortTokens);
    });
  });

  describe('Retry Logic', () => {
    it('should return successful response on first try', async () => {
      const fn = vi.fn(async () => new Response('OK', { status: 200 }));

      const response = await withRetry(fn);

      expect(response.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on 5xx errors', async () => {
      let attempt = 0;
      const fn = vi.fn(async () => {
        attempt += 1;
        if (attempt < 3) {
          return new Response('Error', { status: 500 });
        }
        return new Response('OK', { status: 200 });
      });

      const response = await withRetry(fn, {
        baseMs: 0,
        jitterMs: 0,
        maxAttempts: 3,
        sleep: async () => undefined,
      });

      expect(response.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should retry on 429 rate limit', async () => {
      let attempt = 0;
      const fn = vi.fn(async () => {
        attempt += 1;
        if (attempt < 2) {
          return new Response('Rate limited', { status: 429 });
        }
        return new Response('OK', { status: 200 });
      });

      const response = await withRetry(fn, {
        baseMs: 0,
        jitterMs: 0,
        maxAttempts: 3,
        sleep: async () => undefined,
      });

      expect(response.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 400 errors', async () => {
      const fn = vi.fn(async () => new Response('Bad request', { status: 400 }));

      const response = await withRetry(fn, { maxAttempts: 3 });

      expect(response.status).toBe(400);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 401 errors', async () => {
      const fn = vi.fn(async () => new Response('Unauthorized', { status: 401 }));

      const response = await withRetry(fn, { maxAttempts: 3 });

      expect(response.status).toBe(401);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 403 errors', async () => {
      const fn = vi.fn(async () => new Response('Forbidden', { status: 403 }));

      const response = await withRetry(fn, { maxAttempts: 3 });

      expect(response.status).toBe(403);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should respect maxAttempts limit', async () => {
      const fn = vi.fn(async () => new Response('Error', { status: 500 }));

      const response = await withRetry(fn, {
        baseMs: 0,
        jitterMs: 0,
        maxAttempts: 2,
        sleep: async () => undefined,
      });

      expect(response.status).toBe(500);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Retry-After Parsing', () => {
    it('should parse numeric retry-after (seconds)', () => {
      expect(parseRetryAfterMs('60')).toBe(60000);
      expect(parseRetryAfterMs('1')).toBe(1000);
      expect(parseRetryAfterMs('0.5')).toBe(500);
    });

    it('should parse date retry-after', () => {
      const nowMs = Date.now();
      const futureDate = new Date(nowMs + 30000).toUTCString();

      const result = parseRetryAfterMs(futureDate, nowMs);

      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(31000);
    });

    it('should return null for invalid values', () => {
      expect(parseRetryAfterMs(null)).toBeNull();
      expect(parseRetryAfterMs('')).toBeNull();
      expect(parseRetryAfterMs('invalid-date')).toBeNull();
    });

    it('should return 0 for past dates', () => {
      const nowMs = Date.now();
      const pastDate = new Date(nowMs - 30000).toUTCString();

      const result = parseRetryAfterMs(pastDate, nowMs);

      expect(result).toBe(0);
    });
  });

  describe('Gemini Retry Delay Parsing', () => {
    it('should parse numeric seconds', () => {
      const details = [{ retryDelay: 30 }];
      expect(parseGeminiRetryDelayMs(details)).toBe(30000);
    });

    it('should parse string seconds format', () => {
      const details = [{ retryDelay: '45s' }];
      expect(parseGeminiRetryDelayMs(details)).toBe(45000);
    });

    it('should parse object with seconds and nanos', () => {
      const details = [{ retryDelay: { seconds: 2, nanos: 500000000 } }];
      expect(parseGeminiRetryDelayMs(details)).toBe(2500);
    });

    it('should return null for empty details', () => {
      expect(parseGeminiRetryDelayMs(undefined)).toBeNull();
      expect(parseGeminiRetryDelayMs([])).toBeNull();
    });
  });

  describe('SSE Parsing', () => {
    async function collectSSEEvents(stream: ReadableStream<Uint8Array>): Promise<string[]> {
      const events: string[] = [];
      for await (const event of parseSSE(stream)) {
        events.push(event);
      }
      return events;
    }

    function createStream(data: string): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(data));
          controller.close();
        },
      });
    }

    it('should parse simple SSE events', async () => {
      const events = await collectSSEEvents(createStream('data: {"test": "value"}\n\n'));

      expect(events.length).toBe(1);
      expect(events[0]).toBe('{"test": "value"}');
    });

    it('should parse multiple events', async () => {
      const input = 'data: first\n\ndata: second\n\n';
      const events = await collectSSEEvents(createStream(input));

      expect(events.length).toBe(2);
      expect(events[0]).toBe('first');
      expect(events[1]).toBe('second');
    });

    it('should handle multiline data', async () => {
      const input = 'data: line1\ndata: line2\n\n';
      const events = await collectSSEEvents(createStream(input));

      expect(events.length).toBe(1);
      expect(events[0]).toBe('line1\nline2');
    });

    it('should ignore comments', async () => {
      const input = ': this is a comment\ndata: actual data\n\n';
      const events = await collectSSEEvents(createStream(input));

      expect(events.length).toBe(1);
      expect(events[0]).toBe('actual data');
    });

    it('should handle empty input', async () => {
      const events = await collectSSEEvents(createStream(''));
      expect(events.length).toBe(0);
    });

    it('should filter out [DONE] marker', async () => {
      const events = await collectSSEEvents(createStream('data: [DONE]\n\n'));

      expect(events.length).toBe(0);
    });
  });
});
