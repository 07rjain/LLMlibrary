import { describe, expect, it } from 'vitest';

import { RedisSessionStore } from '../src/session-store.js';

describe('RedisSessionStore', () => {
  it('stores, reads, lists, and deletes session snapshots', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<{
      messages: unknown[];
      totalCostUSD: number;
    }>({
      client,
      keyPrefix: 'test:sessions',
      now: () => new Date('2026-04-15T12:00:00.000Z'),
      ttlSeconds: 300,
    });

    const record = await store.set(
      'session-1',
      {
        messages: [{ content: 'Hello', role: 'user' }],
        totalCostUSD: 0.25,
      },
      {
        model: 'gpt-4o',
        provider: 'openai',
        tenantId: 'tenant-1',
      },
    );

    expect(record).toEqual({
      meta: {
        createdAt: '2026-04-15T12:00:00.000Z',
        messageCount: 1,
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        totalCostUSD: 0.25,
        updatedAt: '2026-04-15T12:00:00.000Z',
      },
      snapshot: {
        messages: [{ content: 'Hello', role: 'user' }],
        totalCostUSD: 0.25,
      },
    });
    expect(client.lastSetOptions).toEqual({ EX: 300 });

    expect(await store.get('session-1', 'tenant-1')).toEqual(record);
    expect(await store.list()).toEqual([record.meta]);

    await store.delete('session-1', 'tenant-1');
    expect(await store.get('session-1', 'tenant-1')).toBeNull();
  });

  it('filters by tenant id and falls back to keys() when scanIterator() is unavailable', async () => {
    const client = new MockRedisClient(false);
    const store = new RedisSessionStore<{
      messages: unknown[];
      totalCostUSD: number;
    }>({
      client,
      keyPrefix: 'tenant:sessions',
      now: () => new Date('2026-04-15T12:00:00.000Z'),
    });

    await store.set(
      'session-a',
      {
        messages: [{ content: 'Hello', role: 'user' }],
        totalCostUSD: 0,
      },
      {
        tenantId: 'tenant-a',
      },
    );
    await store.set(
      'session-b',
      {
        messages: [{ content: 'Hi', role: 'user' }],
        totalCostUSD: 0,
      },
      {
        tenantId: 'tenant-b',
      },
    );

    expect(await store.list({ tenantId: 'tenant-a' })).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        tenantId: 'tenant-a',
      }),
    ]);
  });
});

class MockRedisClient {
  readonly records = new Map<string, string>();
  lastSetOptions: unknown;
  scanIterator?: (options?: { MATCH?: string }) => AsyncIterable<string>;

  constructor(enableScanIterator = true) {
    if (enableScanIterator) {
      this.scanIterator = (options?: { MATCH?: string }) => {
        return {
          [Symbol.asyncIterator]: async function* (this: MockRedisClient) {
            for (const key of this.records.keys()) {
              if (!options?.MATCH || matchesPattern(key, options.MATCH)) {
                yield key;
              }
            }
          }.bind(this),
        };
      };
    }
  }

  async del(key: string): Promise<number> {
    const existed = this.records.delete(key);
    return existed ? 1 : 0;
  }

  async get(key: string): Promise<null | string> {
    return this.records.get(key) ?? null;
  }

  async keys(pattern: string): Promise<string[]> {
    return [...this.records.keys()].filter((key) => matchesPattern(key, pattern));
  }

  async set(key: string, value: string, options?: unknown): Promise<'OK'> {
    this.records.set(key, value);
    this.lastSetOptions = options;
    return 'OK';
  }
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.endsWith('*')) {
    return value === pattern;
  }

  return value.startsWith(pattern.slice(0, -1));
}
