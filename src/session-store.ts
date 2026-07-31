import { loadPgPoolConstructor } from './node-pg-loader.js';
import { getEnvironmentVariable } from './runtime.js';
import {
  RedisSessionStoreCapabilityError,
  RedisSessionStoreKeyConflictError,
} from 'unified-llm-client/errors';

import type { CanonicalProvider } from './types.js';

/** Metadata stored alongside a session snapshot. */
export interface SessionMeta {
  createdAt: string;
  messageCount: number;
  model?: string;
  provider?: CanonicalProvider;
  sessionId: string;
  tenantId?: string;
  totalCostUSD: number;
  updatedAt: string;
}

/** Serialized session record returned by a `SessionStore`. */
export interface SessionRecord<TSnapshot = unknown> {
  meta: SessionMeta;
  snapshot: TSnapshot;
}

/** Filter options for `SessionStore.list()`. */
export interface SessionStoreListOptions {
  tenantId?: string;
}

/** Write metadata for `SessionStore.set()`. */
export interface SessionStoreSetOptions {
  createdAt?: string;
  model?: string;
  provider?: CanonicalProvider;
  tenantId?: string;
}

/** Contract for durable conversation persistence backends. */
export interface SessionStore<TSnapshot = unknown> {
  delete(sessionId: string, tenantId?: string): Promise<void>;
  get(sessionId: string, tenantId?: string): Promise<null | SessionRecord<TSnapshot>>;
  list(options?: SessionStoreListOptions): Promise<SessionMeta[]>;
  set(
    sessionId: string,
    snapshot: TSnapshot,
    options?: SessionStoreSetOptions,
  ): Promise<SessionRecord<TSnapshot>>;
}

/** Row shape returned by the Postgres session store. */
export interface PostgresSessionStoreRow<TSnapshot> {
  created_at: Date | string;
  message_count: number;
  model: null | string;
  provider: CanonicalProvider | null;
  session_id: string;
  snapshot: TSnapshot;
  tenant_id: string;
  total_cost_usd: number | string;
  updated_at: Date | string;
}

/** Minimal query result contract used by Postgres-backed stores/loggers. */
export interface PostgresSessionStoreQueryResult<TRow = Record<string, unknown>> {
  rowCount?: null | number;
  rows: TRow[];
}

/** Minimal Postgres pool contract used by the session store. */
export interface PostgresSessionStorePool {
  end?: () => Promise<void>;
  query: <TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<PostgresSessionStoreQueryResult<TRow>>;
}

/** Configuration for `PostgresSessionStore`. */
export interface PostgresSessionStoreOptions {
  connectionString?: string;
  now?: () => Date;
  pool?: PostgresSessionStorePool;
  schemaName?: string;
  tableName?: string;
}

/** Redis scan options consumed by `RedisSessionStore`. */
export interface RedisScanIteratorOptions {
  COUNT?: number;
  MATCH?: string;
}

/** Minimal Redis client contract required by `RedisSessionStore`. */
export interface RedisSessionStoreClient {
  del(key: string): Promise<number>;
  get(key: string): Promise<null | string>;
  /** @deprecated RedisSessionStore never calls KEYS. Provide scanIterator instead. */
  keys?(pattern: string): Promise<string[]>;
  scanIterator?(
    options?: RedisScanIteratorOptions,
  ): AsyncIterable<readonly string[] | string>;
  set(
    key: string,
    value: string,
    options?: { EX?: number } | { expiration?: { type: 'EX'; value: number } },
  ): Promise<unknown>;
}

/** Configuration for `RedisSessionStore`. */
export interface RedisSessionStoreOptions {
  client: RedisSessionStoreClient;
  keyPrefix?: string;
  maxScanIterations?: number;
  maxScanKeys?: number;
  maxScanNoProgressIterations?: number;
  now?: () => Date;
  scanCount?: number;
  ttlSeconds?: number;
}

/** Simple in-process store intended for tests and single-process development. */
export class InMemorySessionStore<TSnapshot extends { messages: unknown[]; totalCostUSD: number }>
  implements SessionStore<TSnapshot>
{
  private readonly now: () => Date;
  private readonly records = new Map<string, SessionRecord<TSnapshot>>();

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async delete(sessionId: string, tenantId?: string): Promise<void> {
    this.records.delete(buildSessionKey(sessionId, tenantId));
  }

  async get(
    sessionId: string,
    tenantId?: string,
  ): Promise<null | SessionRecord<TSnapshot>> {
    const record = this.records.get(buildSessionKey(sessionId, tenantId));
    if (!record) {
      return null;
    }

    return cloneRecord(record);
  }

  async list(options: SessionStoreListOptions = {}): Promise<SessionMeta[]> {
    return [...this.records.values()]
      .filter((record) =>
        options.tenantId === undefined ? true : record.meta.tenantId === options.tenantId,
      )
      .map((record) => cloneMeta(record.meta))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async set(
    sessionId: string,
    snapshot: TSnapshot,
    options: SessionStoreSetOptions = {},
  ): Promise<SessionRecord<TSnapshot>> {
    const key = buildSessionKey(sessionId, options.tenantId);
    const existing = this.records.get(key);
    const timestamp = this.now().toISOString();
    const meta: SessionMeta = {
      createdAt: existing?.meta.createdAt ?? options.createdAt ?? timestamp,
      messageCount: snapshot.messages.length,
      sessionId,
      totalCostUSD: snapshot.totalCostUSD,
      updatedAt: timestamp,
      ...(existing?.meta.model ?? options.model ? { model: existing?.meta.model ?? options.model } : {}),
      ...(existing?.meta.provider ?? options.provider
        ? { provider: existing?.meta.provider ?? options.provider }
        : {}),
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    };

    const record: SessionRecord<TSnapshot> = {
      meta,
      snapshot: cloneValue(snapshot),
    };
    this.records.set(key, record);
    return cloneRecord(record);
  }
}

/**
 * Postgres-backed durable session store with tenant scoping and indexed lookup.
 *
 * @example
 * ```ts
 * const store = PostgresSessionStore.fromEnv();
 * await store.ensureSchema();
 * ```
 */
export class PostgresSessionStore<
  TSnapshot extends { messages: unknown[]; totalCostUSD: number },
> implements SessionStore<TSnapshot>
{
  private readonly connectionString: string | undefined;
  private ensureSchemaPromise: null | Promise<void> = null;
  private internalPool: PostgresSessionStorePool | undefined;
  private readonly now: () => Date;
  private readonly pool: PostgresSessionStorePool | undefined;
  private readonly schemaName: string;
  private readonly tableName: string;

  constructor(options: PostgresSessionStoreOptions = {}) {
    this.connectionString = options.connectionString;
    this.now = options.now ?? (() => new Date());
    this.pool = options.pool;
    this.schemaName = options.schemaName ?? 'public';
    this.tableName = options.tableName ?? 'llm_sessions';
  }

  static fromEnv<TSnapshot extends { messages: unknown[]; totalCostUSD: number }>(
    options: Omit<PostgresSessionStoreOptions, 'connectionString'> = {},
  ): PostgresSessionStore<TSnapshot> {
    const connectionString = getEnvironmentVariable('DATABASE_URL');
    return new PostgresSessionStore<TSnapshot>({
      ...options,
      ...(connectionString ? { connectionString } : {}),
    });
  }

  async close(): Promise<void> {
    if (!this.internalPool?.end) {
      return;
    }

    await this.internalPool.end();
    this.internalPool = undefined;
    this.ensureSchemaPromise = null;
  }

  async delete(sessionId: string, tenantId?: string): Promise<void> {
    await this.ensureSchema();
    const pool = await this.getPool();
    await pool.query(
      `DELETE FROM ${this.qualifiedTableName()} WHERE tenant_id = $1 AND session_id = $2`,
      [normalizeTenantId(tenantId), sessionId],
    );
  }

  async get(
    sessionId: string,
    tenantId?: string,
  ): Promise<null | SessionRecord<TSnapshot>> {
    await this.ensureSchema();

    const pool = await this.getPool();
    const result = await pool.query<PostgresSessionStoreRow<TSnapshot>>(
      `SELECT session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at
       FROM ${this.qualifiedTableName()}
       WHERE tenant_id = $1 AND session_id = $2
       LIMIT 1`,
      [normalizeTenantId(tenantId), sessionId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return mapPostgresRecord(row);
  }

  async list(options: SessionStoreListOptions = {}): Promise<SessionMeta[]> {
    await this.ensureSchema();

    const filterByTenant = options.tenantId !== undefined;
    const pool = await this.getPool();
    const result = await pool.query<PostgresSessionStoreRow<TSnapshot>>(
      `SELECT session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at
       FROM ${this.qualifiedTableName()}
       ${filterByTenant ? 'WHERE tenant_id = $1' : ''}
       ORDER BY updated_at DESC`,
      filterByTenant ? [normalizeTenantId(options.tenantId)] : [],
    );

    return result.rows.map((row) => mapPostgresMeta(row));
  }

  async set(
    sessionId: string,
    snapshot: TSnapshot,
    options: SessionStoreSetOptions = {},
  ): Promise<SessionRecord<TSnapshot>> {
    await this.ensureSchema();

    const timestamp = this.now().toISOString();
    const tenantId = normalizeTenantId(options.tenantId);
    const pool = await this.getPool();
    const result = await pool.query<PostgresSessionStoreRow<TSnapshot>>(
      `INSERT INTO ${this.qualifiedTableName()} (
         tenant_id,
         session_id,
         snapshot,
         message_count,
         model,
         provider,
         total_cost_usd,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, session_id)
       DO UPDATE SET
         snapshot = EXCLUDED.snapshot,
         message_count = EXCLUDED.message_count,
         model = EXCLUDED.model,
         provider = EXCLUDED.provider,
         total_cost_usd = EXCLUDED.total_cost_usd,
         updated_at = EXCLUDED.updated_at
       RETURNING session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at`,
      [
        tenantId,
        sessionId,
        JSON.stringify(snapshot),
        snapshot.messages.length,
        options.model ?? null,
        options.provider ?? null,
        snapshot.totalCostUSD,
        options.createdAt ?? timestamp,
        timestamp,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Postgres session upsert did not return a row.');
    }

    return mapPostgresRecord(row);
  }

  async ensureSchema(): Promise<void> {
    if (!this.ensureSchemaPromise) {
      this.ensureSchemaPromise = this.runEnsureSchema();
    }

    await this.ensureSchemaPromise;
  }

  private qualifiedTableName(): string {
    return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(this.tableName)}`;
  }

  private async getPool(): Promise<PostgresSessionStorePool> {
    if (this.pool) {
      return this.pool;
    }

    if (this.internalPool) {
      return this.internalPool;
    }

    const connectionString = this.connectionString ?? getEnvironmentVariable('DATABASE_URL');
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is required for PostgresSessionStore. Set it in .env or pass connectionString explicitly.',
      );
    }

    const Pool = await loadPgPoolConstructor();
    const pool = new Pool({
      connectionString,
    });
    this.internalPool = pool;
    return pool;
  }

  private async runEnsureSchema(): Promise<void> {
    const pool = await this.getPool();
    const qualifiedTableName = this.qualifiedTableName();
    const updatedAtIndexName = quoteIdentifier(
      `${this.tableName}_tenant_updated_at_idx`,
    );
    const snapshotIndexName = quoteIdentifier(`${this.tableName}_snapshot_gin_idx`);

    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
         tenant_id TEXT NOT NULL DEFAULT '',
         session_id TEXT NOT NULL,
         snapshot JSONB NOT NULL,
         message_count INTEGER NOT NULL,
         model TEXT,
         provider TEXT,
         total_cost_usd DOUBLE PRECISION NOT NULL,
         created_at TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL,
         PRIMARY KEY (tenant_id, session_id)
       )`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${updatedAtIndexName}
       ON ${qualifiedTableName} (tenant_id, updated_at DESC)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${snapshotIndexName}
       ON ${qualifiedTableName} USING GIN (snapshot)`,
    );
  }
}

/**
 * Redis-backed session store with optional TTL-based expiration.
 *
 * @example
 * ```ts
 * const store = new RedisSessionStore({
 *   client: redis,
 *   ttlSeconds: 3600,
 * });
 * ```
 */
export class RedisSessionStore<
  TSnapshot extends { messages: unknown[]; totalCostUSD: number },
> implements SessionStore<TSnapshot>
{
  private readonly client: RedisSessionStoreClient;
  private readonly keyPrefix: string;
  private readonly maxScanIterations: number;
  private readonly maxScanKeys: number;
  private readonly maxScanNoProgressIterations: number;
  private readonly now: () => Date;
  private readonly scanCount: number;
  private readonly ttlSeconds: number | undefined;

  constructor(options: RedisSessionStoreOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? 'llm:sessions';
    this.maxScanIterations = boundedScanOption(
      options.maxScanIterations,
      10_000,
    );
    this.maxScanKeys = boundedScanOption(options.maxScanKeys, 100_000);
    this.maxScanNoProgressIterations = boundedScanOption(
      options.maxScanNoProgressIterations,
      100,
    );
    this.now = options.now ?? (() => new Date());
    this.scanCount = Math.min(boundedScanOption(options.scanCount, 100), 1_000);
    this.ttlSeconds = options.ttlSeconds;
  }

  async delete(sessionId: string, tenantId?: string): Promise<void> {
    await this.deleteIfIdentityMatches(
      this.key(sessionId, tenantId),
      sessionId,
      tenantId,
    );
    await this.deleteIfIdentityMatches(
      this.legacyKey(sessionId, tenantId),
      sessionId,
      tenantId,
    );
  }

  async get(
    sessionId: string,
    tenantId?: string,
  ): Promise<null | SessionRecord<TSnapshot>> {
    const raw = await this.client.get(this.key(sessionId, tenantId));
    if (raw) {
      try {
        const record = parseRedisRecord<TSnapshot>(raw);
        if (redisRecordMatches(record, sessionId, tenantId)) {
          return record;
        }
      } catch {
        // Malformed or unverifiable v2 data is a soft miss for compatibility
        // reads, so a valid legacy record can still be recovered.
      }
    }

    const legacyRaw = await this.client.get(
      this.legacyKey(sessionId, tenantId),
    );
    if (!legacyRaw) {
      return null;
    }

    try {
      const legacyRecord = parseRedisRecord<TSnapshot>(legacyRaw);
      return redisRecordMatches(legacyRecord, sessionId, tenantId)
        ? legacyRecord
        : null;
    } catch {
      return null;
    }
  }

  async list(options: SessionStoreListOptions = {}): Promise<SessionMeta[]> {
    const records = new Map<string, { meta: SessionMeta; version: 1 | 2 }>();

    for await (const key of this.iterateKeys()) {
      const raw = await this.client.get(key);
      if (!raw) {
        continue;
      }

      let record: SessionRecord<TSnapshot>;
      try {
        record = parseRedisRecord<TSnapshot>(raw);
      } catch {
        continue;
      }
      if (!hasRedisRecordIdentity(record)) {
        continue;
      }

      const v2Key = this.key(record.meta.sessionId, record.meta.tenantId);
      const legacyKey = this.legacyKey(
        record.meta.sessionId,
        record.meta.tenantId,
      );
      const version = key === v2Key ? 2 : key === legacyKey ? 1 : undefined;
      if (version === undefined) {
        continue;
      }
      if (
        options.tenantId !== undefined &&
        normalizeTenantId(record.meta.tenantId) !==
          normalizeTenantId(options.tenantId)
      ) {
        continue;
      }

      const tupleKey = buildSessionKey(
        record.meta.sessionId,
        record.meta.tenantId,
      );
      const existing = records.get(tupleKey);
      if (!existing || version > existing.version) {
        records.set(tupleKey, { meta: cloneMeta(record.meta), version });
      }
    }

    return [...records.values()]
      .map((record) => record.meta)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async set(
    sessionId: string,
    snapshot: TSnapshot,
    options: SessionStoreSetOptions = {},
  ): Promise<SessionRecord<TSnapshot>> {
    const key = this.key(sessionId, options.tenantId);
    const v2Raw = await this.client.get(key);
    let existing: null | SessionRecord<TSnapshot>;
    if (v2Raw) {
      try {
        existing = parseRedisRecord<TSnapshot>(v2Raw);
      } catch {
        throw new RedisSessionStoreKeyConflictError();
      }
      if (!redisRecordMatches(existing, sessionId, options.tenantId)) {
        throw new RedisSessionStoreKeyConflictError();
      }
    } else {
      existing = await this.get(sessionId, options.tenantId);
    }
    const timestamp = this.now().toISOString();
    const meta: SessionMeta = {
      createdAt: existing?.meta.createdAt ?? options.createdAt ?? timestamp,
      messageCount: snapshot.messages.length,
      sessionId,
      totalCostUSD: snapshot.totalCostUSD,
      updatedAt: timestamp,
      ...(existing?.meta.model ?? options.model ? { model: existing?.meta.model ?? options.model } : {}),
      ...(existing?.meta.provider ?? options.provider
        ? { provider: existing?.meta.provider ?? options.provider }
        : {}),
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    };
    const record: SessionRecord<TSnapshot> = {
      meta,
      snapshot: cloneValue(snapshot),
    };

    await this.client.set(
      key,
      JSON.stringify(record),
      buildRedisSetOptions(this.ttlSeconds),
    );

    return cloneRecord(record);
  }

  private key(sessionId: string, tenantId?: string): string {
    return `${this.keyPrefix}:${buildSessionKey(sessionId, tenantId)}`;
  }

  private legacyKey(sessionId: string, tenantId?: string): string {
    return `${this.keyPrefix}:${normalizeTenantId(tenantId)}:${sessionId}`;
  }

  private async deleteIfIdentityMatches(
    key: string,
    sessionId: string,
    tenantId: string | undefined,
  ): Promise<void> {
    const raw = await this.client.get(key);
    if (!raw) {
      return;
    }

    try {
      const record = parseRedisRecord<TSnapshot>(raw);
      if (redisRecordMatches(record, sessionId, tenantId)) {
        await this.client.del(key);
      }
    } catch {
      // Malformed or unverifiable compatibility data is never deleted blindly.
    }
  }

  private async *iterateKeys(): AsyncGenerator<string, void, void> {
    if (!this.client.scanIterator) {
      throw new RedisSessionStoreCapabilityError(
        'list',
        'unsupported_redis_scan_capability',
      );
    }

    const seen = new Set<string>();
    let iterationCount = 0;
    let keyCount = 0;
    let noProgressCount = 0;
    const pattern = `${escapeRedisGlob(this.keyPrefix)}:*`;

    try {
      for await (const result of this.client.scanIterator({
        COUNT: this.scanCount,
        MATCH: pattern,
      })) {
        iterationCount += 1;
        if (iterationCount > this.maxScanIterations) {
          throw new RedisSessionStoreCapabilityError(
            'list',
            'redis_scan_iteration_limit_exceeded',
          );
        }

        const keys = typeof result === 'string' ? [result] : result;
        let progressed = false;
        for (const key of keys) {
          keyCount += 1;
          if (keyCount > this.maxScanKeys) {
            throw new RedisSessionStoreCapabilityError(
              'list',
              'redis_scan_key_limit_exceeded',
            );
          }
          if (typeof key !== 'string' || seen.has(key)) {
            continue;
          }
          seen.add(key);
          progressed = true;
          yield key;
        }

        noProgressCount = progressed ? 0 : noProgressCount + 1;
        if (noProgressCount > this.maxScanNoProgressIterations) {
          throw new RedisSessionStoreCapabilityError(
            'list',
            'redis_scan_no_progress',
          );
        }
      }
    } catch (error) {
      if (error instanceof RedisSessionStoreCapabilityError) {
        throw error;
      }
      throw new RedisSessionStoreCapabilityError(
        'list',
        'redis_scan_adapter_error',
      );
    }
  }
}

function buildSessionKey(
  sessionId: string,
  tenantId: string | undefined,
): string {
  return `v2:${encodeBase64Url(normalizeTenantId(tenantId))}:${encodeBase64Url(sessionId)}`;
}

function boundedScanOption(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

function encodeBase64Url(value: string): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new TextEncoder().encode(value);
  let encoded = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      encoded += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) {
      encoded += alphabet[third & 0x3f];
    }
  }

  return encoded;
}

function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, '\\$&');
}

function hasRedisRecordIdentity<TSnapshot>(
  record: SessionRecord<TSnapshot>,
): record is SessionRecord<TSnapshot> & {
  meta: SessionMeta & { sessionId: string };
} {
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.meta === 'object' &&
    record.meta !== null &&
    typeof record.meta.sessionId === 'string' &&
    (record.meta.tenantId === undefined ||
      typeof record.meta.tenantId === 'string')
  );
}

function redisRecordMatches<TSnapshot>(
  record: SessionRecord<TSnapshot>,
  sessionId: string,
  tenantId: string | undefined,
): boolean {
  return (
    hasRedisRecordIdentity(record) &&
    record.meta.sessionId === sessionId &&
    normalizeTenantId(record.meta.tenantId) === normalizeTenantId(tenantId)
  );
}

function mapPostgresRecord<TSnapshot>(
  row: PostgresSessionStoreRow<TSnapshot>,
): SessionRecord<TSnapshot> {
  return {
    meta: mapPostgresMeta(row),
    snapshot: cloneValue(row.snapshot),
  };
}

function mapPostgresMeta<TSnapshot>(
  row: PostgresSessionStoreRow<TSnapshot>,
): SessionMeta {
  return {
    createdAt: toIsoString(row.created_at),
    messageCount: row.message_count,
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    sessionId: row.session_id,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    totalCostUSD: Number(row.total_cost_usd),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeTenantId(tenantId: string | undefined): string {
  return tenantId ?? '';
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function cloneRecord<TSnapshot>(
  record: SessionRecord<TSnapshot>,
): SessionRecord<TSnapshot> {
  return {
    meta: cloneMeta(record.meta),
    snapshot: cloneValue(record.snapshot),
  };
}

function cloneMeta(meta: SessionMeta): SessionMeta {
  return { ...meta };
}

function cloneValue<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function buildRedisSetOptions(
  ttlSeconds: number | undefined,
):
  | { EX?: number }
  | { expiration?: { type: 'EX'; value: number } }
  | undefined {
  if (ttlSeconds === undefined) {
    return undefined;
  }

  return {
    EX: ttlSeconds,
  };
}

function parseRedisRecord<TSnapshot>(raw: string): SessionRecord<TSnapshot> {
  const parsed = JSON.parse(raw) as SessionRecord<TSnapshot>;
  return cloneRecord(parsed);
}
