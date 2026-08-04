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
import { SessionStoreConflictError } from '../src/errors.js';

interface TestSnapshot {
  marker?: string;
  messages: unknown[];
  totalCostUSD: number;
}

const snapshot = (marker: string): TestSnapshot => ({
  marker,
  messages: [{ content: marker, role: 'user' }],
  totalCostUSD: 0,
});

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

    expect(pool.queries).toHaveLength(8);
    expect(pool.queries[0]?.text).toContain(
      'CREATE SCHEMA IF NOT EXISTS "llm"',
    );
    expect(pool.queries[1]?.text).toContain(
      'CREATE TABLE IF NOT EXISTS "llm"."sessions"',
    );
    expect(pool.queries[3]?.text).toContain(
      'CREATE INDEX IF NOT EXISTS "sessions_tenant_updated_at_idx"',
    );
    expect(pool.queries[7]?.text).toContain(
      'ON CONFLICT (tenant_id, session_id)',
    );
    expect(pool.queries[7]?.values).toEqual([
      'tenant-1',
      'session-1',
      JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        totalCostUSD: 0.5,
        version: 1,
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
        version: 1,
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
        version: 1,
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
        version: 1,
      },
      {
        createdAt: '2026-04-15T08:00:00.000Z',
        messageCount: 1,
        sessionId: 'session-2',
        tenantId: 'tenant-2',
        totalCostUSD: 0,
        updatedAt: '2026-04-15T09:00:00.000Z',
        version: 1,
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

  it('uses metadata-only keyset SQL for filtered Postgres pages', async () => {
    const pool = new MockPool();
    pool.queueRows([
      {
        created_at: '2026-04-15T09:00:00.000Z',
        message_count: 1,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'session-1',
        tenant_id: 'tenant-1',
        total_cost_usd: 0,
        updated_at: '2026-04-15T10:00:00.000Z',
        updated_at_cursor: '2026-04-15T10:00:00.000001Z',
      },
      {
        created_at: '2026-04-15T09:00:00.000Z',
        message_count: 2,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'session-2',
        tenant_id: 'tenant-1',
        total_cost_usd: 0,
        updated_at: '2026-04-15T09:00:00.000Z',
        updated_at_cursor: '2026-04-15T09:00:00.000002Z',
      },
    ]);
    const store = new PostgresSessionStore({ pool });

    const page = await store.listPage({
      limit: 1,
      model: 'gpt-4o',
      provider: 'openai',
      tenantId: 'tenant-1',
    });
    const query = pool.queries.at(-1);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.updatedAt).toBe('2026-04-15T10:00:00.000001Z');
    expect(page.nextCursor).toBeDefined();
    expect(query?.text).toContain('model = $2');
    expect(query?.text).toContain('provider = $3');
    expect(query?.text).toContain('ORDER BY updated_at DESC');
    expect(query?.text).toContain('session_id COLLATE "C" ASC');
    expect(query?.text).toContain('LIMIT $4');
    expect(query?.text).not.toContain('snapshot');
    expect(query?.text).not.toContain('OFFSET');
    expect(query?.values).toEqual(['tenant-1', 'gpt-4o', 'openai', 2]);

    pool.queueRows([
      {
        created_at: '2026-04-15T08:00:00.000Z',
        message_count: 2,
        model: 'gpt-4o',
        provider: 'openai',
        session_id: 'session-2',
        tenant_id: 'tenant-1',
        total_cost_usd: 0,
        updated_at: '2026-04-15T09:00:00.000Z',
        updated_at_cursor: '2026-04-15T09:00:00.000002Z',
      },
    ]);
    await store.listPage({
      cursor: page.nextCursor as string,
      limit: 1,
      model: 'gpt-4o',
      provider: 'openai',
      tenantId: 'tenant-1',
    });
    const cursorQuery = pool.queries.at(-1);

    expect(cursorQuery?.text).toContain('updated_at < $4::timestamptz');
    expect(cursorQuery?.values).toEqual([
      'tenant-1',
      'gpt-4o',
      'openai',
      '2026-04-15T10:00:00.000001000Z',
      'tenant-1',
      'session-1',
      2,
    ]);
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

    expect(pool.queries).toHaveLength(7);
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

  it('uses version predicates for atomic guarded create, update, and delete', async () => {
    const pool = new MockPool();
    const row = {
      created_at: '2026-04-15T09:00:00.000Z',
      message_count: 1,
      model: null,
      provider: null,
      session_id: 'cas-session',
      snapshot: snapshot('created'),
      tenant_id: '',
      total_cost_usd: 0,
      updated_at: '2026-04-15T10:00:00.000Z',
      version: 1,
    };
    pool.queueRows([row]);
    const store = new PostgresSessionStore<TestSnapshot>({
      now: () => new Date('2026-04-15T10:00:00.000Z'),
      pool,
    });

    const created = await store.set('cas-session', snapshot('created'), {
      expectedVersion: 0,
    });
    expect(created.meta.version).toBe(1);
    expect(pool.queries.at(-1)?.text).toContain(
      'ON CONFLICT (tenant_id, session_id) DO NOTHING',
    );

    pool.queueRows([{ ...row, snapshot: snapshot('updated'), version: 2 }]);
    const updated = await store.set('cas-session', snapshot('updated'), {
      expectedVersion: 1,
    });
    expect(updated.meta.version).toBe(2);
    expect(pool.queries.at(-1)?.text).toContain('updated_at = $8');
    expect(pool.queries.at(-1)?.text).toContain('AND version = $9');
    expect(pool.queries.at(-1)?.values).toEqual([
      '',
      'cas-session',
      JSON.stringify({
        marker: 'updated',
        messages: [{ content: 'updated', role: 'user' }],
        totalCostUSD: 0,
        version: 2,
      }),
      1,
      null,
      null,
      0,
      '2026-04-15T10:00:00.000Z',
      1,
    ]);

    await expect(
      store.set('cas-session', snapshot('stale'), { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(SessionStoreConflictError);

    pool.queueRows([{ deleted: true, existed: true }]);
    await store.delete('cas-session', undefined, { expectedVersion: 2 });
    expect(pool.queries.at(-1)?.text).toContain('FOR UPDATE');
    expect(pool.queries.at(-1)?.values).toEqual(['', 'cas-session', 2]);
  });
});

class MockPool implements PostgresSessionStorePool {
  readonly end = vi.fn(async () => undefined);
  readonly options: unknown;
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  private readonly responses: Array<PostgresSessionStoreQueryResult<unknown>> =
    [];

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

    if (
      !/^(INSERT|SELECT|UPDATE|WITH)\b/i.test(normalizedText) ||
      this.responses.length === 0
    ) {
      return { rows: [] };
    }

    return this.responses.shift() as PostgresSessionStoreQueryResult<TRow>;
  }
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
