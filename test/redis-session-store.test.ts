import { describe, expect, it } from 'vitest';

import {
  RedisSessionStoreCapabilityError,
  RedisSessionStoreKeyConflictError,
} from '../src/errors.js';
import {
  InMemorySessionStore,
  RedisSessionStore,
} from '../src/session-store.js';

interface TestSnapshot {
  marker?: string;
  messages: unknown[];
  totalCostUSD: number;
}

const snapshot = (marker?: string): TestSnapshot => ({
  ...(marker === undefined ? {} : { marker }),
  messages: marker ? [{ content: marker, role: 'user' }] : [],
  totalCostUSD: 0,
});

describe('RedisSessionStore', () => {
  it('stores, reads, lists, and deletes session snapshots', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
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
    expect([...client.records.keys()][0]).toMatch(
      /^test:sessions:v2:[A-Za-z0-9_-]*:[A-Za-z0-9_-]+$/,
    );

    expect(await store.get('session-1', 'tenant-1')).toEqual(record);
    expect(await store.list()).toEqual([record.meta]);
    expect(client.setCalls).toBe(1);

    await store.delete('session-1', 'tenant-1');
    expect(await store.get('session-1', 'tenant-1')).toBeNull();
  });

  it('fails closed without scanIterator and never falls back to keys()', async () => {
    const client = new MockRedisClient(false);
    const store = new RedisSessionStore<TestSnapshot>({
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

    await expect(store.list({ tenantId: 'tenant-a' })).rejects.toMatchObject({
      details: {
        code: 'unsupported_redis_scan_capability',
        operation: 'list',
      },
      retryable: false,
      statusCode: 501,
    });
    expect(client.keysCalls).toBe(0);
  });

  it('keeps separator, Unicode, default, and long tuple components injective', async () => {
    const tuples: Array<[string | undefined, string, string]> = [
      ['a:b', 'c', 'first'],
      ['a', 'b:c', 'second'],
      ['%', '%:value', 'percent'],
      [undefined, '', 'empty'],
      ['default', '', 'literal-default'],
      ['租户🙂', '会话🚀', 'unicode'],
      ['e\u0301', 'é', 'combining'],
      ['x'.repeat(4_096), 'y'.repeat(4_096), 'long'],
    ];
    const redisClient = new MockRedisClient();
    const redis = new RedisSessionStore<TestSnapshot>({ client: redisClient });
    const memory = new InMemorySessionStore<TestSnapshot>();

    for (const [tenantId, sessionId, marker] of tuples) {
      const options = tenantId === undefined ? {} : { tenantId };
      await redis.set(sessionId, snapshot(marker), options);
      await memory.set(sessionId, snapshot(marker), options);
    }

    expect(redisClient.records.size).toBe(tuples.length);
    for (const [tenantId, sessionId, marker] of tuples) {
      expect((await redis.get(sessionId, tenantId))?.snapshot.marker).toBe(
        marker,
      );
      expect((await memory.get(sessionId, tenantId))?.snapshot.marker).toBe(
        marker,
      );
    }
  });

  it('uses verified legacy fallback without read-side mutation or cross-tenant access', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
      client,
      keyPrefix: 'legacy',
    });
    const legacyRecord = redisRecord('b:c', 'a', 'legacy-value');
    client.records.set('legacy:a:b:c', JSON.stringify(legacyRecord));

    expect((await store.get('b:c', 'a'))?.snapshot.marker).toBe('legacy-value');
    expect(await store.get('c', 'a:b')).toBeNull();
    expect(client.setCalls).toBe(0);

    await store.delete('c', 'a:b');
    expect(client.records.get('legacy:a:b:c')).toBe(
      JSON.stringify(legacyRecord),
    );
    expect(client.deleteCalls).toBe(0);

    await store.delete('b:c', 'a');
    expect(client.records.has('legacy:a:b:c')).toBe(false);
    expect(client.deleteCalls).toBe(1);
  });

  it('falls through a wrong-identity v2 record to a verified legacy record', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
      client,
      keyPrefix: 'wrong-v2',
    });
    client.records.set(
      'wrong-v2:v2::eA',
      JSON.stringify(redisRecord('other', undefined, 'wrong-v2-owner')),
    );
    client.records.set(
      'wrong-v2::x',
      JSON.stringify(redisRecord('x', undefined, 'legacy-target')),
    );

    expect((await store.get('x'))?.snapshot.marker).toBe('legacy-target');
    expect(client.setCalls).toBe(0);
  });

  it('falls through malformed v2 data to a verified legacy record', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
      client,
      keyPrefix: 'malformed-v2',
    });
    client.records.set('malformed-v2:v2::eA', '{bad');
    client.records.set(
      'malformed-v2::x',
      JSON.stringify(redisRecord('x', undefined, 'legacy-target')),
    );

    expect((await store.get('x'))?.snapshot.marker).toBe('legacy-target');
    expect(client.setCalls).toBe(0);
  });

  it('prefers a valid v2 record when both v2 and legacy records verify', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
      client,
      keyPrefix: 'v2-precedence',
    });
    client.records.set(
      'v2-precedence:v2::eA',
      JSON.stringify(redisRecord('x', undefined, 'v2-target')),
    );
    client.records.set(
      'v2-precedence::x',
      JSON.stringify(redisRecord('x', undefined, 'legacy-target')),
    );

    expect((await store.get('x'))?.snapshot.marker).toBe('v2-target');
  });

  it('does not fall through to a legacy record for another tuple', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
      client,
      keyPrefix: 'cross-tuple',
    });
    client.records.set(
      'cross-tuple:v2::eA',
      JSON.stringify(redisRecord('other-v2', undefined, 'wrong-v2-owner')),
    );
    client.records.set(
      'cross-tuple::x',
      JSON.stringify(redisRecord('x', 'other-tenant', 'wrong-legacy-owner')),
    );

    expect(await store.get('x')).toBeNull();
  });

  it('fails closed instead of overwriting a legacy record occupying a v2 key', async () => {
    const client = new MockRedisClient();
    const occupiedKey = 'llm:sessions:v2::eA';
    const occupiedValue = JSON.stringify(redisRecord(':eA', 'v2', 'legacy-owner'));
    const targetLegacyKey = 'llm:sessions::x';
    const targetLegacyValue = JSON.stringify(
      redisRecord('x', undefined, 'target-legacy'),
    );
    client.records.set(occupiedKey, occupiedValue);
    client.records.set(targetLegacyKey, targetLegacyValue);
    const store = new RedisSessionStore<TestSnapshot>({ client });

    await expect(store.set('x', snapshot('new-owner'))).rejects.toBeInstanceOf(
      RedisSessionStoreKeyConflictError,
    );
    expect(client.records.get(occupiedKey)).toBe(occupiedValue);
    expect(client.records.get(targetLegacyKey)).toBe(targetLegacyValue);
    expect(client.setCalls).toBe(0);
  });

  it('deduplicates v2 and legacy records with v2 precedence and skips malformed legacy data', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
      client,
      keyPrefix: 'migration',
    });
    await store.set('same', snapshot('v2'), { tenantId: 'tenant' });
    const v2Key = [...client.records.keys()][0] as string;
    const v2Record = JSON.parse(
      client.records.get(v2Key) as string,
    ) as ReturnType<typeof redisRecord>;
    client.records.set(
      'migration:tenant:same',
      JSON.stringify({ ...v2Record, snapshot: snapshot('legacy') }),
    );
    client.records.set(
      'migration:other:distinct',
      JSON.stringify(redisRecord('distinct', 'other', 'distinct')),
    );
    client.records.set('migration:broken:value', '{bad');

    const rows = await store.list();
    expect(
      rows.map((row) => `${row.tenantId}:${row.sessionId}`).sort(),
    ).toEqual(['other:distinct', 'tenant:same']);
    expect((await store.get('same', 'tenant'))?.snapshot.marker).toBe('v2');
    expect(client.setCalls).toBe(1);
  });

  it('migrates on a later write without mutating compatibility reads or refreshing TTL', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({
      client,
      keyPrefix: 'write-migration',
      ttlSeconds: 60,
    });
    const legacyKey = 'write-migration:tenant:session';
    client.records.set(
      legacyKey,
      JSON.stringify(redisRecord('session', 'tenant', 'legacy')),
    );

    expect((await store.get('session', 'tenant'))?.snapshot.marker).toBe(
      'legacy',
    );
    expect((await store.list()).map((row) => row.sessionId)).toEqual([
      'session',
    ]);
    expect(client.setCalls).toBe(0);

    await store.set('session', snapshot('v2'), { tenantId: 'tenant' });
    expect(client.records.has(legacyKey)).toBe(true);
    expect(client.records.size).toBe(2);
    expect(client.lastSetOptions).toEqual({ EX: 60 });
    expect((await store.get('session', 'tenant'))?.snapshot.marker).toBe('v2');
    expect((await store.list()).map((row) => row.sessionId)).toEqual([
      'session',
    ]);
    expect(client.setCalls).toBe(1);
  });

  it('accepts batched cluster-safe scan iterators and deduplicates repeated keys', async () => {
    const client = new MockRedisClient();
    const store = new RedisSessionStore<TestSnapshot>({ client });
    await store.set('a', snapshot('a'));
    await store.set('b', snapshot('b'));
    const keys = [...client.records.keys()];
    client.scanIterator = async function* () {
      yield keys;
      yield [keys[0] as string];
    };

    expect((await store.list()).map((row) => row.sessionId).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('bounds duplicate/no-progress, iteration, and key-heavy scan adapters', async () => {
    const duplicateClient = new MockRedisClient();
    duplicateClient.scanIterator = async function* () {
      while (true) {
        yield 'duplicate';
      }
    };
    const duplicateStore = new RedisSessionStore<TestSnapshot>({
      client: duplicateClient,
      maxScanNoProgressIterations: 2,
    });
    await expect(duplicateStore.list()).rejects.toMatchObject({
      details: { code: 'redis_scan_no_progress' },
    });

    const iterationClient = new MockRedisClient();
    iterationClient.scanIterator = async function* () {
      let index = 0;
      while (true) {
        yield `key-${index++}`;
      }
    };
    const iterationStore = new RedisSessionStore<TestSnapshot>({
      client: iterationClient,
      maxScanIterations: 2,
      maxScanKeys: 100,
    });
    await expect(iterationStore.list()).rejects.toMatchObject({
      details: { code: 'redis_scan_iteration_limit_exceeded' },
    });

    const keyClient = new MockRedisClient();
    keyClient.scanIterator = async function* () {
      yield ['one', 'two', 'three'];
    };
    const keyStore = new RedisSessionStore<TestSnapshot>({
      client: keyClient,
      maxScanKeys: 2,
    });
    await expect(keyStore.list()).rejects.toMatchObject({
      details: { code: 'redis_scan_key_limit_exceeded' },
    });

    await expect(duplicateStore.list()).rejects.toBeInstanceOf(
      RedisSessionStoreCapabilityError,
    );
  });

  it('wraps scan adapter failures without leaking adapter data or using keys()', async () => {
    const client = new MockRedisClient();
    client.scanIterator = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<string>> => {
          throw new Error('adapter failed while scanning secret:tenant:session');
        },
      }),
    });
    const store = new RedisSessionStore<TestSnapshot>({ client });

    const error = await store.list().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RedisSessionStoreCapabilityError);
    expect(error).toMatchObject({
      cause: undefined,
      details: {
        code: 'redis_scan_adapter_error',
        operation: 'list',
      },
      retryable: false,
      statusCode: 502,
    });
    expect(JSON.stringify((error as RedisSessionStoreCapabilityError).toJSON()))
      .not.toContain('secret:tenant:session');
    expect(client.keysCalls).toBe(0);
  });
});

class MockRedisClient {
  readonly records = new Map<string, string>();
  deleteCalls = 0;
  keysCalls = 0;
  lastSetOptions: unknown;
  setCalls = 0;
  scanIterator?: (options?: {
    MATCH?: string;
  }) => AsyncIterable<readonly string[] | string>;

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
    this.deleteCalls += 1;
    const existed = this.records.delete(key);
    return existed ? 1 : 0;
  }

  async get(key: string): Promise<null | string> {
    return this.records.get(key) ?? null;
  }

  async keys(pattern: string): Promise<string[]> {
    this.keysCalls += 1;
    return [...this.records.keys()].filter((key) =>
      matchesPattern(key, pattern),
    );
  }

  async set(key: string, value: string, options?: unknown): Promise<'OK'> {
    this.setCalls += 1;
    this.records.set(key, value);
    this.lastSetOptions = options;
    return 'OK';
  }
}

function redisRecord(
  sessionId: string,
  tenantId: string | undefined,
  marker: string,
) {
  const timestamp = '2026-04-15T12:00:00.000Z';
  return {
    meta: {
      createdAt: timestamp,
      messageCount: 1,
      sessionId,
      ...(tenantId === undefined ? {} : { tenantId }),
      totalCostUSD: 0,
      updatedAt: timestamp,
    },
    snapshot: snapshot(marker),
  };
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.endsWith('*')) {
    return value === pattern;
  }

  return value.startsWith(pattern.slice(0, -1));
}
