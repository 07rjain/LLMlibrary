import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMockState = vi.hoisted(() => {
  return {
    createdPools: [] as unknown[],
    poolConstructor: vi.fn(),
  };
});

const createdPools = pgMockState.createdPools as MockPool[];

vi.mock('pg', () => {
  return {
    Pool: pgMockState.poolConstructor,
  };
});

import {
  PostgresSessionStore,
  type PostgresSessionStorePool,
  type PostgresSessionStoreQueryResult,
} from '../src/session-store.js';

describe('PostgresSessionStore', () => {
  beforeEach(() => {
    createdPools.length = 0;
    pgMockState.poolConstructor.mockClear();
    pgMockState.poolConstructor.mockImplementation((options?: unknown) => {
      const pool = new MockPool(options);
      createdPools.push(pool);
      return pool;
    });
    delete process.env.DATABASE_URL;
  });

  it('creates schema objects and upserts session snapshots', async () => {
    const pool = new MockPool();
    pool.queueRows([
      {
        created_at: '2026-04-15T09:00:00.000Z',
        message_count: 1,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'session-1',
        snapshot: {
          messages: [{ content: 'Hello', role: 'user' }],
          totalCostUSD: 0.5,
        },
        tenant_id: 'tenant-1',
        total_cost_usd: 0.5,
        updated_at: '2026-04-15T10:00:00.000Z',
      },
    ]);

    const store = new PostgresSessionStore({
      now: () => new Date('2026-04-15T10:00:00.000Z'),
      pool,
      schemaName: 'llm',
      tableName: 'sessions',
    });

    const record = await store.set(
      'session-1',
      {
        messages: [{ content: 'Hello', role: 'user' }],
        totalCostUSD: 0.5,
      },
      {
        createdAt: '2026-04-15T09:00:00.000Z',
        model: 'gpt-4o',
        provider: 'openai',
        tenantId: 'tenant-1',
      },
    );

    expect(pool.queries).toHaveLength(5);
    expect(pool.queries[0]?.text).toContain('CREATE SCHEMA IF NOT EXISTS "llm"');
    expect(pool.queries[1]?.text).toContain('CREATE TABLE IF NOT EXISTS "llm"."sessions"');
    expect(pool.queries[2]?.text).toContain(
      'CREATE INDEX IF NOT EXISTS "sessions_tenant_updated_at_idx"',
    );
    expect(pool.queries[4]?.text).toContain('ON CONFLICT (tenant_id, session_id)');
    expect(pool.queries[4]?.values).toEqual([
      'tenant-1',
      'session-1',
      JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        totalCostUSD: 0.5,
      }),
      1,
      'gpt-4o',
      'openai',
      0.5,
      '2026-04-15T09:00:00.000Z',
      '2026-04-15T10:00:00.000Z',
    ]);
    expect(record).toEqual({
      meta: {
        createdAt: '2026-04-15T09:00:00.000Z',
        messageCount: 1,
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        totalCostUSD: 0.5,
        updatedAt: '2026-04-15T10:00:00.000Z',
      },
      snapshot: {
        messages: [{ content: 'Hello', role: 'user' }],
        totalCostUSD: 0.5,
      },
    });
  });

  it('gets, lists, and deletes tenant-scoped rows', async () => {
    const pool = new MockPool();
    pool.queueRows([
      {
        created_at: '2026-04-15T09:00:00.000Z',
        message_count: 2,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'session-1',
        snapshot: {
          messages: [
            { content: 'Hello', role: 'user' },
            { content: 'Hi', role: 'assistant' },
          ],
          totalCostUSD: 0.75,
        },
        tenant_id: '',
        total_cost_usd: '0.75',
        updated_at: '2026-04-15T10:00:00.000Z',
      },
    ]);
    pool.queueRows([
      {
        created_at: '2026-04-15T09:00:00.000Z',
        message_count: 2,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'session-1',
        snapshot: {
          messages: [
            { content: 'Hello', role: 'user' },
            { content: 'Hi', role: 'assistant' },
          ],
          totalCostUSD: 0.75,
        },
        tenant_id: '',
        total_cost_usd: 0.75,
        updated_at: '2026-04-15T10:00:00.000Z',
      },
      {
        created_at: '2026-04-15T08:00:00.000Z',
        message_count: 1,
        model: null,
        provider: null,
        session_id: 'session-2',
        snapshot: {
          messages: [{ content: 'Hi', role: 'user' }],
          totalCostUSD: 0,
        },
        tenant_id: 'tenant-2',
        total_cost_usd: 0,
        updated_at: '2026-04-15T09:00:00.000Z',
      },
    ]);

    const store = new PostgresSessionStore({
      pool,
    });

    expect(await store.get('session-1')).toEqual({
      meta: {
        createdAt: '2026-04-15T09:00:00.000Z',
        messageCount: 2,
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'session-1',
        totalCostUSD: 0.75,
        updatedAt: '2026-04-15T10:00:00.000Z',
      },
      snapshot: {
        messages: [
          { content: 'Hello', role: 'user' },
          { content: 'Hi', role: 'assistant' },
        ],
        totalCostUSD: 0.75,
      },
    });

    expect(await store.list()).toEqual([
      {
        createdAt: '2026-04-15T09:00:00.000Z',
        messageCount: 2,
        model: 'gpt-4o',
        provider: 'openai',
        sessionId: 'session-1',
        totalCostUSD: 0.75,
        updatedAt: '2026-04-15T10:00:00.000Z',
      },
      {
        createdAt: '2026-04-15T08:00:00.000Z',
        messageCount: 1,
        sessionId: 'session-2',
        tenantId: 'tenant-2',
        totalCostUSD: 0,
        updatedAt: '2026-04-15T09:00:00.000Z',
      },
    ]);

    await store.delete('session-1', 'tenant-2');
    expect(pool.queries.at(-1)?.values).toEqual(['tenant-2', 'session-1']);
  });

  it('filters list() by tenant id', async () => {
    const pool = new MockPool();
    pool.queueRows([
      {
        created_at: '2026-04-15T09:00:00.000Z',
        message_count: 1,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'session-tenant',
        snapshot: {
          messages: [{ content: 'Hello', role: 'user' }],
          totalCostUSD: 0.1,
        },
        tenant_id: 'tenant-1',
        total_cost_usd: 0.1,
        updated_at: '2026-04-15T10:00:00.000Z',
      },
    ]);

    const store = new PostgresSessionStore({
      pool,
    });

    const items = await store.list({ tenantId: 'tenant-1' });

    expect(items).toHaveLength(1);
    expect(pool.queries.at(-1)?.text).toContain('WHERE tenant_id = $1');
    expect(pool.queries.at(-1)?.values).toEqual(['tenant-1']);
  });

  it('uses DATABASE_URL through fromEnv() and closes owned pools', async () => {
    process.env.DATABASE_URL = 'postgresql://example.test/db';

    const store = PostgresSessionStore.fromEnv<{
      messages: unknown[];
      totalCostUSD: number;
    }>();

    const pool = new MockPool({ connectionString: process.env.DATABASE_URL });
    createdPools.push(pool);
    pgMockState.poolConstructor.mockImplementationOnce(() => pool);

    await store.ensureSchema();
    await store.close();

    expect(pgMockState.poolConstructor).toHaveBeenCalledWith({
      connectionString: 'postgresql://example.test/db',
    });
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('reuses ensureSchema() work across repeated calls', async () => {
    const pool = new MockPool();
    const store = new PostgresSessionStore({
      pool,
    });

    await store.ensureSchema();
    await store.ensureSchema();

    expect(pool.queries).toHaveLength(4);
  });

  it('throws when DATABASE_URL is missing and no pool is provided', async () => {
    const store = new PostgresSessionStore<{
      messages: unknown[];
      totalCostUSD: number;
    }>();

    await expect(store.ensureSchema()).rejects.toThrow(
      'DATABASE_URL is required for PostgresSessionStore.',
    );
  });

  it('returns null when no row exists', async () => {
    const pool = new MockPool();
    const store = new PostgresSessionStore({
      pool,
    });

    await expect(store.get('missing')).resolves.toBeNull();
  });
});

class MockPool implements PostgresSessionStorePool {
  readonly end = vi.fn(async () => undefined);
  readonly options: unknown;
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  private readonly responses: Array<PostgresSessionStoreQueryResult<unknown>> = [];

  constructor(options?: unknown) {
    this.options = options;
  }

  queueRows(rows: unknown[]): void {
    this.responses.push({ rows });
  }

  async query<TRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<PostgresSessionStoreQueryResult<TRow>> {
    const normalizedText = normalizeSql(text);
    this.queries.push({
      text: normalizedText,
      values,
    });

    if (!/^(INSERT|SELECT)\b/i.test(normalizedText) || this.responses.length === 0) {
      return { rows: [] };
    }

    return this.responses.shift() as PostgresSessionStoreQueryResult<TRow>;
  }
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
