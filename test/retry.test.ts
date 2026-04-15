import { describe, expect, it, vi } from 'vitest';

import {
  parseGeminiRetryDelayMs,
  parseRetryAfterMs,
  withRetry,
} from '../src/utils/retry.js';

describe('parseRetryAfterMs', () => {
  it('returns null for missing values', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  it('parses seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30000);
  });

  it('parses HTTP dates', () => {
    expect(
      parseRetryAfterMs('Tue, 15 Apr 2026 10:00:30 GMT', Date.parse('Tue, 15 Apr 2026 10:00:00 GMT')),
    ).toBe(30000);
  });

  it('returns null for invalid values', () => {
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });
});

describe('parseGeminiRetryDelayMs', () => {
  it('returns null when details are missing', () => {
    expect(parseGeminiRetryDelayMs(undefined)).toBeNull();
  });

  it('parses numeric retry delays', () => {
    expect(parseGeminiRetryDelayMs([{ retryDelay: 2 }])).toBe(2000);
  });

  it('parses retryDelay strings', () => {
    expect(parseGeminiRetryDelayMs([{ retryDelay: '1.5s' }])).toBe(1500);
  });

  it('parses retryDelay objects', () => {
    expect(
      parseGeminiRetryDelayMs([{ retryDelay: { nanos: 500000000, seconds: 2 } }]),
    ).toBe(2500);
  });

  it('returns null for unparseable retry delays', () => {
    expect(parseGeminiRetryDelayMs([{ retryDelay: 'soon' }])).toBeNull();
  });
});

describe('withRetry', () => {
  it('retries 429 responses using Retry-After', async () => {
    const responses = [
      new Response('', { headers: { 'retry-after': '2' }, status: 429 }),
      new Response('ok', { status: 200 }),
    ];
    const sleep = vi.fn(async (_ms: number) => undefined);

    const response = await withRetry(async () => responses.shift() as Response, {
      random: () => 0,
      sleep,
    });

    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries 500 responses with exponential backoff', async () => {
    const responses = [
      new Response('', { status: 500 }),
      new Response('', { status: 503 }),
      new Response('ok', { status: 200 }),
    ];
    const sleep = vi.fn(async (_ms: number) => undefined);

    const response = await withRetry(async () => responses.shift() as Response, {
      jitterMs: 0,
      sleep,
    });

    expect(response.status).toBe(200);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn(async () => new Response('', { status: 400 }));

    const response = await withRetry(fn);

    expect(response.status).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses Gemini retryDelay when Retry-After is unavailable', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const payload = {
      error: {
        details: [{ retryDelay: '3s' }],
      },
    };
    const fn = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
          status: 429,
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await withRetry(fn, {
      random: () => 0,
      sleep,
    });

    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('returns the last response when max attempts are exhausted', async () => {
    const fn = vi.fn(async () => new Response('', { status: 500 }));

    const response = await withRetry(fn, {
      jitterMs: 0,
      maxAttempts: 3,
      sleep: async () => undefined,
    });

    expect(response.status).toBe(500);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('falls back to exponential delay when Gemini error details cannot be parsed', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const fn = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response('not-json', {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const response = await withRetry(fn, {
      jitterMs: 0,
      sleep,
    });

    expect(response.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
