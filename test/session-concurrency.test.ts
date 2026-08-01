import { describe, expect, it, vi } from 'vitest';

import {
  Conversation,
  type ConversationClient,
  type ConversationSnapshot,
} from '../src/conversation.js';
import {
  RedisSessionStoreCapabilityError,
  SessionStoreConflictError,
} from '../src/errors.js';
import {
  InMemorySessionStore,
  RedisSessionStore,
  type RedisSessionStoreClient,
} from '../src/session-store.js';
import type { CanonicalResponse } from '../src/types.js';

interface Snapshot {
  marker?: string;
  messages: unknown[];
  totalCostUSD: number;
  version?: number;
}

const snapshot = (marker: string): Snapshot => ({
  marker,
  messages: [{ content: marker, role: 'user' }],
  totalCostUSD: 0,
});

describe('session optimistic concurrency', () => {
  it('allows one winner in a 20-writer update storm', async () => {
    const store = new InMemorySessionStore<Snapshot>();
    const created = await store.set('storm', snapshot('base'), {
      expectedVersion: 0,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        store.set('storm', snapshot(`writer-${index}`), {
          expectedVersion: created.meta.version ?? 0,
        }),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const conflicts = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(conflicts).toHaveLength(19);
    expect(
      conflicts.every(
        (result) => result.reason instanceof SessionStoreConflictError,
      ),
    ).toBe(true);
    expect((await store.get('storm'))?.meta.version).toBe(2);
  });

  it('enforces create/create and stale update/delete semantics', async () => {
    const store = new InMemorySessionStore<Snapshot>();
    const creates = await Promise.allSettled([
      store.set('create-race', snapshot('left'), { expectedVersion: 0 }),
      store.set('create-race', snapshot('right'), { expectedVersion: 0 }),
    ]);
    expect(
      creates.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    const current = await store.get('create-race');
    expect(current?.meta.version).toBe(1);
    const mutations = await Promise.allSettled([
      store.set('create-race', snapshot('updated'), {
        expectedVersion: current?.meta.version ?? 0,
      }),
      store.delete('create-race', undefined, {
        expectedVersion: current?.meta.version ?? 0,
      }),
    ]);
    expect(
      mutations.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      mutations.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('keeps versions sequential and isolated by tenant', async () => {
    const store = new InMemorySessionStore<Snapshot>();
    const tenantA = await store.set('shared', snapshot('a1'), {
      expectedVersion: 0,
      tenantId: 'tenant-a',
    });
    const tenantB = await store.set('shared', snapshot('b1'), {
      expectedVersion: 0,
      tenantId: 'tenant-b',
    });
    const tenantA2 = await store.set('shared', snapshot('a2'), {
      expectedVersion: tenantA.meta.version ?? 0,
      tenantId: 'tenant-a',
    });
    expect(tenantA.meta.version).toBe(1);
    expect(tenantB.meta.version).toBe(1);
    expect(tenantA2.meta.version).toBe(2);
    expect((await store.get('shared', 'tenant-b'))?.snapshot.marker).toBe('b1');
  });

  it('rejects one stale conversation and preserves both turns after reload', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const seedClient = responseClient(async () => response('unused'));
    const seed = new Conversation(seedClient, { sessionId: 'cnv-022' });
    const initial = await store.set('cnv-022', seed.serialise(), {
      expectedVersion: 0,
    });

    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete: ConversationClient['complete'] = vi.fn(async (options) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      const prompt = options.messages.at(-1)?.content as string;
      return response(`reply:${prompt}`);
    });
    const client = responseClient(complete);
    const base = { ...initial.snapshot, version: initial.meta.version };
    const left = Conversation.restore(client, base, { store });
    const right = Conversation.restore(client, base, { store });

    const raced = await Promise.allSettled([
      left.send('left'),
      right.send('right'),
    ]);
    expect(
      raced.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const loser = raced.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(loser?.reason).toBeInstanceOf(SessionStoreConflictError);
    expect(left.history.length === 0 || right.history.length === 0).toBe(true);

    const committed = await store.get('cnv-022');
    const winningPrompt = committed?.snapshot.messages[0]?.content;
    expect(typeof winningPrompt).toBe('string');
    const retryPrompt = winningPrompt === 'left' ? 'right' : 'left';
    const reloaded = Conversation.restore(
      responseClient(async () => response(`reply:${retryPrompt}`)),
      { ...committed?.snapshot, version: committed?.meta.version },
      { store },
    );
    await reloaded.send(retryPrompt);

    const final = await store.get('cnv-022');
    expect(final?.snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'left', role: 'user' }),
        expect.objectContaining({ content: 'right', role: 'user' }),
      ]),
    );
    expect(final?.meta.version).toBe(3);
    const staleConversation = left.history.length === 0 ? left : right;
    expect(staleConversation.serialise().version).toBe(1);
  });

  it('does not advance version after provider failure', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const seed = new Conversation(
      responseClient(async () => response('seed')),
      {
        sessionId: 'provider-failure',
      },
    );
    const initial = await store.set('provider-failure', seed.serialise(), {
      expectedVersion: 0,
    });
    const conversation = Conversation.restore(
      responseClient(async () => {
        throw new Error('provider failed');
      }),
      { ...initial.snapshot, version: initial.meta.version },
      { store },
    );

    await expect(conversation.send('not committed')).rejects.toThrow(
      'provider failed',
    );
    expect(conversation.serialise().version).toBe(1);
    expect((await store.get('provider-failure'))?.meta.version).toBe(1);
  });

  it('normalizes legacy snapshots to version zero', () => {
    const legacy = new Conversation(
      responseClient(async () => response('x')),
      {
        sessionId: 'legacy-version',
      },
    ).serialise();
    delete legacy.version;
    expect(
      Conversation.restore(
        responseClient(async () => response('x')),
        legacy,
      ).serialise().version,
    ).toBe(0);
  });

  it('restores and mutates a versionless InMemory record without losing CAS', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const seeded = await store.set(
      'legacy-memory',
      {
        ...new Conversation(
          responseClient(async () => response('seed')),
          {
            sessionId: 'legacy-memory',
          },
        ).serialise(),
        messages: [],
      },
      { expectedVersion: 0 },
    );
    const records = (
      store as unknown as {
        records: Map<
          string,
          { meta: { version?: number }; snapshot: { version?: number } }
        >;
      }
    ).records;
    const legacy = records.values().next().value;
    expect(legacy).toBeDefined();
    delete legacy?.meta.version;
    delete legacy?.snapshot.version;

    const loaded = await store.get('legacy-memory');
    expect(loaded?.meta.version).toBe(1);
    expect(loaded?.snapshot.version).toBe(1);
    if (!loaded) {
      throw new Error('Expected the legacy record to load.');
    }
    const firstCas = await store.set('legacy-memory', loaded.snapshot, {
      expectedVersion: 1,
    });
    expect(firstCas.meta.version).toBe(2);
    await expect(
      store.set('legacy-memory', loaded.snapshot, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(SessionStoreConflictError);
    const restored = Conversation.restore(
      responseClient(async () => response('reply')),
      firstCas.snapshot,
      { store },
    );
    await restored.send('continue');
    expect((await store.get('legacy-memory'))?.meta.version).toBe(3);
    await store.delete('legacy-memory', undefined, { expectedVersion: 3 });
    expect(await store.get('legacy-memory')).toBeNull();
    expect(seeded.meta.version).toBe(1);
  });

  it('uses one atomic Redis eval per guarded mutation', async () => {
    const client = new AtomicRedisClient();
    const store = new RedisSessionStore<Snapshot>({ client });
    const created = await store.set('redis-storm', snapshot('base'), {
      expectedVersion: 0,
    });
    expect(created.meta.version).toBe(1);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        store.set('redis-storm', snapshot(`redis-${index}`), {
          expectedVersion: 1,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect((await store.get('redis-storm'))?.meta.version).toBe(2);
    expect(client.evalCalls).toBe(21);
  });

  it('CAS-migrates a legacy-only Redis record and supports ioredis eval shape', async () => {
    const client = new AtomicRedisClient();
    const legacyKey = 'llm:sessions:tenant:legacy-redis';
    client.records.set(
      legacyKey,
      JSON.stringify({
        meta: {
          createdAt: '2026-04-15T12:00:00.000Z',
          messageCount: 1,
          sessionId: 'legacy-redis',
          tenantId: 'tenant',
          totalCostUSD: 0,
          updatedAt: '2026-04-15T12:00:00.000Z',
        },
        snapshot: snapshot('legacy'),
      }),
    );
    const store = new RedisSessionStore<Snapshot>({ client });
    expect((await store.get('legacy-redis', 'tenant'))?.meta.version).toBe(1);
    const updated = await store.set('legacy-redis', snapshot('updated'), {
      expectedVersion: 1,
      tenantId: 'tenant',
    });
    expect(updated.meta.version).toBe(2);
    expect(client.records.has(legacyKey)).toBe(false);
    await store.delete('legacy-redis', 'tenant', { expectedVersion: 2 });

    const ioredis = new AtomicRedisClient();
    const calls: number[] = [];
    const ioredisClient: RedisSessionStoreClient = {
      del: ioredis.del.bind(ioredis),
      eval: async (script, keyCountOrOptions, ...rest) => {
        if (typeof keyCountOrOptions !== 'number') {
          throw new Error('expected ioredis numeric eval form');
        }
        calls.push(keyCountOrOptions);
        return ioredis.eval!(script, {
          arguments: rest.slice(keyCountOrOptions),
          keys: rest.slice(0, keyCountOrOptions),
        });
      },
      get: ioredis.get.bind(ioredis),
      set: ioredis.set.bind(ioredis),
    };
    const ioredisStore = new RedisSessionStore<Snapshot>({
      client: ioredisClient,
      evalMode: 'ioredis',
    });
    await ioredisStore.set('ioredis', snapshot('one'), { expectedVersion: 0 });
    expect(calls).toEqual([2]);
  });

  it('fails closed before reads when Redis eval is unavailable', async () => {
    const client = new AtomicRedisClient();
    const store = new RedisSessionStore<Snapshot>({
      client: {
        del: client.del.bind(client),
        get: client.get.bind(client),
        set: client.set.bind(client),
      },
    });

    await expect(
      store.set('unsupported', snapshot('value'), { expectedVersion: 0 }),
    ).rejects.toMatchObject({
      details: {
        code: 'unsupported_redis_atomic_write_capability',
        operation: 'set',
      },
      retryable: false,
      statusCode: 501,
    });
    expect(client.getCalls).toBe(0);
    expect(client.setCalls).toBe(0);
    await expect(
      store.delete('unsupported', undefined, { expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(RedisSessionStoreCapabilityError);
    expect(client.getCalls).toBe(0);
  });
});

function responseClient(
  complete: ConversationClient['complete'],
): ConversationClient {
  return { complete, stream: vi.fn() };
}

function response(text: string): CanonicalResponse {
  return {
    content: [{ text, type: 'text' }],
    finishReason: 'stop',
    model: 'mock-model',
    provider: 'mock',
    raw: {},
    text,
    toolCalls: [],
    usage: {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: 1,
      outputTokens: 1,
    },
  };
}

class AtomicRedisClient implements RedisSessionStoreClient {
  readonly records = new Map<string, string>();
  evalCalls = 0;
  getCalls = 0;
  setCalls = 0;

  eval: NonNullable<RedisSessionStoreClient['eval']> = async (
    script,
    optionsOrKeyCount,
  ) => {
    this.evalCalls += 1;
    if (typeof optionsOrKeyCount === 'number') {
      throw new Error('test client expects node-redis eval options');
    }
    const keys = optionsOrKeyCount.keys;
    const key = keys[0] as string;
    const args = optionsOrKeyCount.arguments;
    const expected = Number(args[0]);
    let sourceKey = key;
    let raw = this.records.get(key);
    if (!raw && keys[1]) {
      sourceKey = keys[1];
      raw = this.records.get(sourceKey);
    }
    if (args.length === 3) {
      if (!raw) {
        return expected === 0
          ? '__SESSION_OK__'
          : '__SESSION_VERSION_CONFLICT__';
      }
      const current = JSON.parse(raw) as {
        meta: { sessionId: string; tenantId?: string; version?: number };
      };
      if (
        current.meta.sessionId !== args[1] ||
        (current.meta.tenantId ?? '') !== args[2]
      ) {
        return '__SESSION_KEY_CONFLICT__';
      }
      if ((current.meta.version ?? 1) !== expected || expected === 0) {
        return '__SESSION_VERSION_CONFLICT__';
      }
      this.records.delete(sourceKey);
      return '__SESSION_OK__';
    }

    const candidate = JSON.parse(args[1] as string) as {
      meta: Record<string, unknown> & {
        createdAt: string;
        sessionId: string;
        tenantId?: string;
      };
      snapshot: Snapshot;
    };
    let nextVersion = 1;
    if (raw) {
      const current = JSON.parse(raw) as typeof candidate & {
        meta: typeof candidate.meta & { version?: number };
      };
      if (
        current.meta.sessionId !== args[3] ||
        (current.meta.tenantId ?? '') !== args[4]
      ) {
        return '__SESSION_KEY_CONFLICT__';
      }
      const currentVersion = current.meta.version ?? 1;
      if (expected === 0 || currentVersion !== expected) {
        return '__SESSION_VERSION_CONFLICT__';
      }
      nextVersion = currentVersion + 1;
      candidate.meta.createdAt = current.meta.createdAt;
      for (const field of ['model', 'provider'] as const) {
        if (current.meta[field] !== undefined) {
          candidate.meta[field] = current.meta[field];
        }
      }
    } else if (expected !== 0) {
      return '__SESSION_VERSION_CONFLICT__';
    }
    candidate.meta.version = nextVersion;
    candidate.snapshot.version = nextVersion;
    const encoded = JSON.stringify(candidate);
    this.records.set(key, encoded);
    if (sourceKey !== key) this.records.delete(sourceKey);
    return encoded;
  };

  async del(key: string): Promise<number> {
    return this.records.delete(key) ? 1 : 0;
  }

  async get(key: string): Promise<null | string> {
    this.getCalls += 1;
    return this.records.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.setCalls += 1;
    this.records.set(key, value);
    return 'OK';
  }
}
