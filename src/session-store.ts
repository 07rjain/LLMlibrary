import { loadPgPoolConstructor } from './node-pg-loader.js';
import { getEnvironmentVariable } from './runtime.js';
import {
  InvalidSessionStoreListOptionsError,
  RedisSessionStoreCapabilityError,
  RedisSessionStoreKeyConflictError,
  SessionStoreConflictError,
} from 'unified-llm-client/errors';

import type { CanonicalProvider } from './types.js';

export { SessionStoreConflictError };

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
  /** Monotonic store revision used for optimistic concurrency control. */
  version?: number;
}

/** Serialized session record returned by a `SessionStore`. */
export interface SessionRecord<TSnapshot = unknown> {
  meta: SessionMeta;
  snapshot: TSnapshot;
}

/** Direction used by keyset-based session listing. */
export type SessionStoreListDirection = 'backward' | 'forward';

/** Filter and pagination options for session-store listing. */
export interface SessionStoreListOptions {
  cursor?: string;
  direction?: SessionStoreListDirection;
  limit?: number;
  model?: string;
  provider?: CanonicalProvider;
  tenantId?: string;
}

/** Opaque keyset page returned by core session stores. */
export interface SessionStorePage {
  items: SessionMeta[];
  nextCursor?: string;
  previousCursor?: string;
}

/** Write metadata for `SessionStore.set()`. */
export interface SessionStoreSetOptions {
  createdAt?: string;
  model?: string;
  provider?: CanonicalProvider;
  tenantId?: string;
  /** Expected committed version. Zero requires that the session is absent. */
  expectedVersion?: number;
}

/** Atomic-delete options for a session store. */
export interface SessionStoreDeleteOptions {
  expectedVersion?: number;
}

/** Contract for durable conversation persistence backends. */
export interface SessionStore<TSnapshot = unknown> {
  delete(
    sessionId: string,
    tenantId?: string,
    options?: SessionStoreDeleteOptions,
  ): Promise<void>;
  get(
    sessionId: string,
    tenantId?: string,
  ): Promise<null | SessionRecord<TSnapshot>>;
  list(options?: SessionStoreListOptions): Promise<SessionMeta[]>;
  listPage?(options?: SessionStoreListOptions): Promise<SessionStorePage>;
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
  version?: number | string;
}

/** Metadata-only row returned by paginated Postgres session listing. */
export type PostgresSessionMetaRow = Omit<
  PostgresSessionStoreRow<never>,
  'snapshot'
> & {
  updated_at_cursor?: string;
};

/** Minimal query result contract used by Postgres-backed stores/loggers. */
export interface PostgresSessionStoreQueryResult<
  TRow = Record<string, unknown>,
> {
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
  eval?(
    script: string,
    optionsOrKeyCount: number | { arguments: string[]; keys: string[] },
    ...args: string[]
  ): Promise<unknown>;
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
  /** Redis eval calling convention. Defaults to node-redis object arguments. */
  evalMode?: 'ioredis' | 'node-redis';
  keyPrefix?: string;
  maxScanIterations?: number;
  maxScanKeys?: number;
  maxScanNoProgressIterations?: number;
  now?: () => Date;
  scanCount?: number;
  ttlSeconds?: number;
}

const REDIS_KEY_CONFLICT = '__SESSION_KEY_CONFLICT__';
const REDIS_VERSION_CONFLICT = '__SESSION_VERSION_CONFLICT__';
const REDIS_OK = '__SESSION_OK__';

const REDIS_CAS_SET_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local expected = tonumber(ARGV[1])
local candidate = cjson.decode(ARGV[2])
local nextVersion = 1
local sourceKey = KEYS[1]
if raw then
  local ok, current = pcall(cjson.decode, raw)
  if not ok or type(current) ~= 'table' or type(current.meta) ~= 'table' then
    return '${REDIS_KEY_CONFLICT}'
  end
  local currentTenant = current.meta.tenantId or ''
  if current.meta.sessionId ~= ARGV[4] or currentTenant ~= ARGV[5] then
    return '${REDIS_KEY_CONFLICT}'
  end
  local currentVersion = tonumber(current.meta.version) or 1
  if expected == 0 or currentVersion ~= expected then
    return '${REDIS_VERSION_CONFLICT}'
  end
  nextVersion = currentVersion + 1
  candidate.meta.createdAt = current.meta.createdAt or candidate.meta.createdAt
  if current.meta.model then candidate.meta.model = current.meta.model end
  if current.meta.provider then candidate.meta.provider = current.meta.provider end
else
  local legacyRaw = redis.call('GET', KEYS[2])
  if legacyRaw then
    local legacyOk, legacy = pcall(cjson.decode, legacyRaw)
    if legacyOk and type(legacy) == 'table' and type(legacy.meta) == 'table' then
      local legacyTenant = legacy.meta.tenantId or ''
      if legacy.meta.sessionId == ARGV[4] and legacyTenant == ARGV[5] then
        raw = legacyRaw
        sourceKey = KEYS[2]
        local currentVersion = tonumber(legacy.meta.version) or 1
        if expected == 0 or currentVersion ~= expected then
          return '${REDIS_VERSION_CONFLICT}'
        end
        nextVersion = currentVersion + 1
        candidate.meta.createdAt = legacy.meta.createdAt or candidate.meta.createdAt
        if legacy.meta.model then candidate.meta.model = legacy.meta.model end
        if legacy.meta.provider then candidate.meta.provider = legacy.meta.provider end
      end
    end
  end
  if not raw and expected ~= 0 then return '${REDIS_VERSION_CONFLICT}' end
end
candidate.meta.version = nextVersion
candidate.snapshot.version = nextVersion
local encoded = cjson.encode(candidate)
local ttl = tonumber(ARGV[3]) or 0
if ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
if sourceKey == KEYS[2] then redis.call('DEL', KEYS[2]) end
return encoded
`;

const REDIS_CAS_DELETE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local expected = tonumber(ARGV[1])
local sourceKey = KEYS[1]
if not raw then
  local legacyRaw = redis.call('GET', KEYS[2])
  if legacyRaw then
    local legacyOk, legacy = pcall(cjson.decode, legacyRaw)
    if legacyOk and type(legacy) == 'table' and type(legacy.meta) == 'table' then
      local legacyTenant = legacy.meta.tenantId or ''
      if legacy.meta.sessionId == ARGV[2] and legacyTenant == ARGV[3] then
        raw = legacyRaw
        sourceKey = KEYS[2]
      end
    end
  end
  if not raw then
    if expected == 0 then return '${REDIS_OK}' end
    return '${REDIS_VERSION_CONFLICT}'
  end
end
local ok, current = pcall(cjson.decode, raw)
if not ok or type(current) ~= 'table' or type(current.meta) ~= 'table' then
  return '${REDIS_KEY_CONFLICT}'
end
local currentTenant = current.meta.tenantId or ''
if current.meta.sessionId ~= ARGV[2] or currentTenant ~= ARGV[3] then
  return '${REDIS_KEY_CONFLICT}'
end
local currentVersion = tonumber(current.meta.version) or 1
if expected == 0 or currentVersion ~= expected then
  return '${REDIS_VERSION_CONFLICT}'
end
redis.call('DEL', sourceKey)
return '${REDIS_OK}'
`;

/** Simple in-process store intended for tests and single-process development. */
export class InMemorySessionStore<
  TSnapshot extends { messages: unknown[]; totalCostUSD: number },
> implements SessionStore<TSnapshot> {
  private readonly now: () => Date;
  private readonly records = new Map<string, SessionRecord<TSnapshot>>();

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Removes every record owned by this in-memory store instance. */
  async clear(): Promise<void> {
    this.records.clear();
  }

  async delete(
    sessionId: string,
    tenantId?: string,
    options: SessionStoreDeleteOptions = {},
  ): Promise<void> {
    validateExpectedVersion(options.expectedVersion);
    const key = buildSessionKey(sessionId, tenantId);
    const existing = this.records.get(key);
    if (
      options.expectedVersion !== undefined &&
      !versionMatches(
        existing?.meta.version,
        options.expectedVersion,
        !!existing,
      )
    ) {
      throw new SessionStoreConflictError('delete');
    }
    this.records.delete(key);
  }

  async get(
    sessionId: string,
    tenantId?: string,
  ): Promise<null | SessionRecord<TSnapshot>> {
    const record = this.records.get(buildSessionKey(sessionId, tenantId));
    if (!record) {
      return null;
    }

    return normalizeRecordVersion(record);
  }

  async list(options: SessionStoreListOptions = {}): Promise<SessionMeta[]> {
    if (hasSessionPaginationOptions(options)) {
      return (await this.listPage(options)).items;
    }

    validateSessionListOptions(options);
    return filterAndSortSessionMetas(
      [...this.records.values()].map(
        (record) => normalizeRecordVersion(record).meta,
      ),
      options,
    );
  }

  async listPage(
    options: SessionStoreListOptions = {},
  ): Promise<SessionStorePage> {
    return paginateSessionMetas(
      filterAndSortSessionMetas(
        [...this.records.values()].map(
          (record) => normalizeRecordVersion(record).meta,
        ),
        options,
      ),
      options,
    );
  }

  async set(
    sessionId: string,
    snapshot: TSnapshot,
    options: SessionStoreSetOptions = {},
  ): Promise<SessionRecord<TSnapshot>> {
    validateExpectedVersion(options.expectedVersion);
    const key = buildSessionKey(sessionId, options.tenantId);
    const existing = this.records.get(key);
    if (
      options.expectedVersion !== undefined &&
      !versionMatches(
        existing?.meta.version,
        options.expectedVersion,
        !!existing,
      )
    ) {
      throw new SessionStoreConflictError('set');
    }
    const timestamp = this.now().toISOString();
    const nextVersion = (existing ? (existing.meta.version ?? 1) : 0) + 1;
    const meta: SessionMeta = {
      createdAt: existing?.meta.createdAt ?? options.createdAt ?? timestamp,
      messageCount: snapshot.messages.length,
      sessionId,
      totalCostUSD: snapshot.totalCostUSD,
      updatedAt: timestamp,
      version: nextVersion,
      ...((existing?.meta.model ?? options.model)
        ? { model: existing?.meta.model ?? options.model }
        : {}),
      ...((existing?.meta.provider ?? options.provider)
        ? { provider: existing?.meta.provider ?? options.provider }
        : {}),
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    };

    const record: SessionRecord<TSnapshot> = {
      meta,
      snapshot: withSnapshotVersion(snapshot, nextVersion),
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
> implements SessionStore<TSnapshot> {
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

  static fromEnv<
    TSnapshot extends { messages: unknown[]; totalCostUSD: number },
  >(
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

  async delete(
    sessionId: string,
    tenantId?: string,
    options: SessionStoreDeleteOptions = {},
  ): Promise<void> {
    validateExpectedVersion(options.expectedVersion);
    await this.ensureSchema();
    const pool = await this.getPool();
    if (options.expectedVersion === undefined) {
      await pool.query(
        `DELETE FROM ${this.qualifiedTableName()} WHERE tenant_id = $1 AND session_id = $2`,
        [normalizeTenantId(tenantId), sessionId],
      );
      return;
    }
    const result = await pool.query<{ deleted: boolean; existed: boolean }>(
      `WITH existing AS (
         SELECT version FROM ${this.qualifiedTableName()}
         WHERE tenant_id = $1 AND session_id = $2
         FOR UPDATE
       ), deleted AS (
         DELETE FROM ${this.qualifiedTableName()}
         WHERE tenant_id = $1 AND session_id = $2 AND version = $3
         RETURNING version
       )
       SELECT EXISTS (SELECT 1 FROM existing) AS existed,
              EXISTS (SELECT 1 FROM deleted) AS deleted`,
      [normalizeTenantId(tenantId), sessionId, options.expectedVersion],
    );
    const outcome = result.rows[0];
    const matches =
      options.expectedVersion === 0
        ? outcome?.existed === false
        : outcome?.deleted === true;
    if (!matches) {
      throw new SessionStoreConflictError('delete');
    }
  }

  async get(
    sessionId: string,
    tenantId?: string,
  ): Promise<null | SessionRecord<TSnapshot>> {
    await this.ensureSchema();

    const pool = await this.getPool();
    const result = await pool.query<PostgresSessionStoreRow<TSnapshot>>(
      `SELECT session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at, version
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
    if (hasSessionPaginationOptions(options)) {
      return (await this.listPage(options)).items;
    }

    await this.ensureSchema();
    validateSessionListOptions(options);
    const pool = await this.getPool();
    const query = buildPostgresSessionListQuery(
      this.qualifiedTableName(),
      options,
    );
    const result = await pool.query<PostgresSessionMetaRow>(
      query.text,
      query.values,
    );

    return result.rows.map((row) => mapPostgresMeta(row));
  }

  async listPage(
    options: SessionStoreListOptions = {},
  ): Promise<SessionStorePage> {
    await this.ensureSchema();
    const normalized = normalizeSessionListOptions(options);
    const pool = await this.getPool();
    const query = buildPostgresSessionListQuery(
      this.qualifiedTableName(),
      options,
      normalized,
    );
    const result = await pool.query<PostgresSessionMetaRow>(
      query.text,
      query.values,
    );
    const rows =
      normalized.direction === 'backward'
        ? [...result.rows].reverse()
        : result.rows;
    const hasMore = rows.length > normalized.limit;
    const window =
      normalized.direction === 'backward'
        ? rows.slice(hasMore ? 1 : 0)
        : rows.slice(0, normalized.limit);

    return buildSessionStorePage(
      window.map((row) => mapPostgresMeta(row)),
      normalized,
      hasMore,
    );
  }

  async set(
    sessionId: string,
    snapshot: TSnapshot,
    options: SessionStoreSetOptions = {},
  ): Promise<SessionRecord<TSnapshot>> {
    validateExpectedVersion(options.expectedVersion);
    await this.ensureSchema();

    const timestamp = this.now().toISOString();
    const tenantId = normalizeTenantId(options.tenantId);
    const pool = await this.getPool();
    const nextVersion = (options.expectedVersion ?? 0) + 1;
    const values: unknown[] = [
      tenantId,
      sessionId,
      JSON.stringify(withSnapshotVersion(snapshot, nextVersion)),
      snapshot.messages.length,
      options.model ?? null,
      options.provider ?? null,
      snapshot.totalCostUSD,
      options.createdAt ?? timestamp,
      timestamp,
    ];
    let result: PostgresSessionStoreQueryResult<
      PostgresSessionStoreRow<TSnapshot>
    >;
    if (options.expectedVersion === 0) {
      result = await pool.query<PostgresSessionStoreRow<TSnapshot>>(
        `INSERT INTO ${this.qualifiedTableName()} AS current_session (
           tenant_id, session_id, snapshot, message_count, model, provider,
           total_cost_usd, created_at, updated_at, version
         )
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, 1)
         ON CONFLICT (tenant_id, session_id) DO NOTHING
         RETURNING session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at, version`,
        values,
      );
    } else if (options.expectedVersion !== undefined) {
      values.push(options.expectedVersion);
      result = await pool.query<PostgresSessionStoreRow<TSnapshot>>(
        `UPDATE ${this.qualifiedTableName()}
         SET snapshot = $3::jsonb,
             message_count = $4,
             model = COALESCE(model, $5),
             provider = COALESCE(provider, $6),
             total_cost_usd = $7,
             updated_at = $9,
             version = version + 1
         WHERE tenant_id = $1 AND session_id = $2 AND version = $10
         RETURNING session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at, version`,
        values,
      );
    } else {
      result = await pool.query<PostgresSessionStoreRow<TSnapshot>>(
        `INSERT INTO ${this.qualifiedTableName()} AS current_session (
           tenant_id, session_id, snapshot, message_count, model, provider,
           total_cost_usd, created_at, updated_at, version
         )
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, 1)
         ON CONFLICT (tenant_id, session_id)
         DO UPDATE SET
           snapshot = jsonb_set(
             EXCLUDED.snapshot,
             '{version}',
             to_jsonb(current_session.version + 1),
             true
           ),
           message_count = EXCLUDED.message_count,
           model = COALESCE(current_session.model, EXCLUDED.model),
           provider = COALESCE(current_session.provider, EXCLUDED.provider),
           total_cost_usd = EXCLUDED.total_cost_usd,
           updated_at = EXCLUDED.updated_at,
           version = current_session.version + 1
         RETURNING session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at, version`,
        values,
      );
    }

    const row = result.rows[0];
    if (!row) {
      if (options.expectedVersion !== undefined) {
        throw new SessionStoreConflictError('set');
      }
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

    const connectionString =
      this.connectionString ?? getEnvironmentVariable('DATABASE_URL');
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
    const tenantPageIndexName = quoteIdentifier(
      `${this.tableName}_tenant_updated_at_session_idx`,
    );
    const filteredPageIndexName = quoteIdentifier(
      `${this.tableName}_tenant_model_provider_updated_at_session_idx`,
    );
    const snapshotIndexName = quoteIdentifier(
      `${this.tableName}_snapshot_gin_idx`,
    );

    await pool.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`,
    );
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
         version BIGINT NOT NULL DEFAULT 1,
         PRIMARY KEY (tenant_id, session_id)
       )`,
    );
    await pool.query(
      `ALTER TABLE ${qualifiedTableName}
       ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${updatedAtIndexName}
       ON ${qualifiedTableName} (tenant_id, updated_at DESC)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${tenantPageIndexName}
       ON ${qualifiedTableName} (
         tenant_id COLLATE "C" ASC,
         updated_at DESC,
         session_id COLLATE "C" ASC
       )`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${filteredPageIndexName}
       ON ${qualifiedTableName} (
         tenant_id COLLATE "C" ASC,
         model COLLATE "C" ASC,
         provider COLLATE "C" ASC,
         updated_at DESC,
         session_id COLLATE "C" ASC
       )`,
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
> implements SessionStore<TSnapshot> {
  private readonly client: RedisSessionStoreClient;
  private readonly evalMode: 'ioredis' | 'node-redis';
  private readonly keyPrefix: string;
  private readonly maxScanIterations: number;
  private readonly maxScanKeys: number;
  private readonly maxScanNoProgressIterations: number;
  private readonly now: () => Date;
  private readonly scanCount: number;
  private readonly ttlSeconds: number | undefined;

  constructor(options: RedisSessionStoreOptions) {
    this.client = options.client;
    this.evalMode = options.evalMode ?? 'node-redis';
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

  async delete(
    sessionId: string,
    tenantId?: string,
    options: SessionStoreDeleteOptions = {},
  ): Promise<void> {
    validateExpectedVersion(options.expectedVersion);
    if (options.expectedVersion !== undefined) {
      const result = await this.atomicEval(
        REDIS_CAS_DELETE_SCRIPT,
        [this.key(sessionId, tenantId), this.legacyKey(sessionId, tenantId)],
        [
          String(options.expectedVersion),
          sessionId,
          normalizeTenantId(tenantId),
        ],
        'delete',
      );
      if (result === REDIS_KEY_CONFLICT) {
        throw new RedisSessionStoreKeyConflictError();
      }
      if (result !== REDIS_OK) {
        throw new SessionStoreConflictError('delete');
      }
      return;
    }
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
    if (hasSessionPaginationOptions(options)) {
      return (await this.listPage(options)).items;
    }

    validateSessionListOptions(options);
    return filterAndSortSessionMetas(await this.collectSessionMetas(), options);
  }

  async listPage(
    options: SessionStoreListOptions = {},
  ): Promise<SessionStorePage> {
    return paginateSessionMetas(
      filterAndSortSessionMetas(await this.collectSessionMetas(), options),
      options,
    );
  }

  private async collectSessionMetas(): Promise<SessionMeta[]> {
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
      const tupleKey = buildSessionKey(
        record.meta.sessionId,
        record.meta.tenantId,
      );
      const existing = records.get(tupleKey);
      if (!existing || version > existing.version) {
        records.set(tupleKey, { meta: cloneMeta(record.meta), version });
      }
    }

    return [...records.values()].map((record) => record.meta);
  }

  async set(
    sessionId: string,
    snapshot: TSnapshot,
    options: SessionStoreSetOptions = {},
  ): Promise<SessionRecord<TSnapshot>> {
    validateExpectedVersion(options.expectedVersion);
    const key = this.key(sessionId, options.tenantId);
    const timestamp = this.now().toISOString();
    if (options.expectedVersion !== undefined) {
      const candidate: SessionRecord<TSnapshot> = {
        meta: {
          createdAt: options.createdAt ?? timestamp,
          messageCount: snapshot.messages.length,
          sessionId,
          totalCostUSD: snapshot.totalCostUSD,
          updatedAt: timestamp,
          ...(options.model ? { model: options.model } : {}),
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.tenantId !== undefined
            ? { tenantId: options.tenantId }
            : {}),
        },
        snapshot: cloneValue(snapshot),
      };
      const result = await this.atomicEval(
        REDIS_CAS_SET_SCRIPT,
        [key, this.legacyKey(sessionId, options.tenantId)],
        [
          String(options.expectedVersion),
          JSON.stringify(candidate),
          String(this.ttlSeconds ?? 0),
          sessionId,
          normalizeTenantId(options.tenantId),
        ],
        'set',
      );
      if (result === REDIS_KEY_CONFLICT) {
        throw new RedisSessionStoreKeyConflictError();
      }
      if (result === REDIS_VERSION_CONFLICT) {
        throw new SessionStoreConflictError('set');
      }
      return parseRedisRecord<TSnapshot>(result);
    }
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
    const meta: SessionMeta = {
      createdAt: existing?.meta.createdAt ?? options.createdAt ?? timestamp,
      messageCount: snapshot.messages.length,
      sessionId,
      totalCostUSD: snapshot.totalCostUSD,
      updatedAt: timestamp,
      version: (existing?.meta.version ?? 0) + 1,
      ...((existing?.meta.model ?? options.model)
        ? { model: existing?.meta.model ?? options.model }
        : {}),
      ...((existing?.meta.provider ?? options.provider)
        ? { provider: existing?.meta.provider ?? options.provider }
        : {}),
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    };
    const record: SessionRecord<TSnapshot> = {
      meta,
      snapshot: withSnapshotVersion(snapshot, meta.version ?? 1),
    };

    await this.client.set(
      key,
      JSON.stringify(record),
      buildRedisSetOptions(this.ttlSeconds),
    );

    return cloneRecord(record);
  }

  private async atomicEval(
    script: string,
    keys: string[],
    args: string[],
    operation: 'delete' | 'set',
  ): Promise<string> {
    if (!this.client.eval) {
      throw new RedisSessionStoreCapabilityError(
        operation,
        'unsupported_redis_atomic_write_capability',
      );
    }
    const evaluator = this.client.eval.bind(this.client);
    const result =
      this.evalMode === 'ioredis'
        ? await evaluator(script, keys.length, ...keys, ...args)
        : await evaluator(script, { arguments: args, keys });
    if (typeof result === 'string') {
      return result;
    }
    if (result instanceof Uint8Array) {
      return new TextDecoder().decode(result);
    }
    return String(result);
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

const DEFAULT_SESSION_PAGE_LIMIT = 20;
const MAX_SESSION_FILTER_LENGTH = 8_192;
const MAX_SESSION_CURSOR_LENGTH = 16_384;
const SESSION_PROVIDERS: readonly CanonicalProvider[] = [
  'anthropic',
  'openai',
  'google',
  'mistral',
  'cohere',
  'groq',
  'bedrock',
  'azure-openai',
  'ollama',
  'mock',
];

interface SessionCursorKey {
  sessionId: string;
  tenantId: string;
  updatedAt: string;
}

interface SessionCursorPayload {
  direction: SessionStoreListDirection;
  key: SessionCursorKey;
  model: null | string;
  provider: CanonicalProvider | null;
  tenantId: null | string;
  version: 1;
}

interface NormalizedSessionListOptions {
  cursor?: SessionCursorPayload;
  direction: SessionStoreListDirection;
  limit: number;
  model?: string;
  provider?: CanonicalProvider;
  tenantId?: string;
}

interface PostgresSessionListQuery {
  text: string;
  values: unknown[];
}

function hasSessionPaginationOptions(
  options: SessionStoreListOptions,
): boolean {
  return (
    options.cursor !== undefined ||
    options.direction !== undefined ||
    options.limit !== undefined
  );
}

function validateSessionListOptions(options: SessionStoreListOptions): void {
  if (options === null || typeof options !== 'object') {
    throw new InvalidSessionStoreListOptionsError(
      'invalid_session_list_filter',
    );
  }

  if (
    options.direction !== undefined &&
    options.direction !== 'forward' &&
    options.direction !== 'backward'
  ) {
    throw new InvalidSessionStoreListOptionsError(
      'invalid_session_list_direction',
    );
  }
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100)
  ) {
    throw new InvalidSessionStoreListOptionsError('invalid_session_list_limit');
  }
  for (const value of [options.tenantId, options.model]) {
    if (
      value !== undefined &&
      (value.length > MAX_SESSION_FILTER_LENGTH || /\p{C}/u.test(value))
    ) {
      throw new InvalidSessionStoreListOptionsError(
        'invalid_session_list_filter',
      );
    }
  }
  if (options.model !== undefined && options.model.length === 0) {
    throw new InvalidSessionStoreListOptionsError(
      'invalid_session_list_filter',
    );
  }
  if (
    options.provider !== undefined &&
    !SESSION_PROVIDERS.includes(options.provider)
  ) {
    throw new InvalidSessionStoreListOptionsError(
      'invalid_session_list_filter',
    );
  }
  if (options.cursor !== undefined && typeof options.cursor !== 'string') {
    throw new InvalidSessionStoreListOptionsError('invalid_session_cursor');
  }
}

function normalizeSessionListOptions(
  options: SessionStoreListOptions,
): NormalizedSessionListOptions {
  validateSessionListOptions(options);
  const direction = options.direction ?? 'forward';
  const normalized: NormalizedSessionListOptions = {
    direction,
    limit: options.limit ?? DEFAULT_SESSION_PAGE_LIMIT,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.tenantId !== undefined
      ? { tenantId: normalizeTenantId(options.tenantId) }
      : {}),
  };
  if (options.cursor !== undefined) {
    normalized.cursor = decodeSessionCursor(options.cursor, normalized);
  }
  return normalized;
}

function filterAndSortSessionMetas(
  metas: SessionMeta[],
  options: SessionStoreListOptions,
): SessionMeta[] {
  validateSessionListOptions(options);
  return metas
    .filter((meta) =>
      options.tenantId === undefined
        ? true
        : normalizeTenantId(meta.tenantId) ===
          normalizeTenantId(options.tenantId),
    )
    .filter(
      (meta) => options.model === undefined || meta.model === options.model,
    )
    .filter(
      (meta) =>
        options.provider === undefined || meta.provider === options.provider,
    )
    .map((meta) => cloneMeta(meta))
    .sort(compareSessionMeta);
}

function paginateSessionMetas(
  sortedMetas: SessionMeta[],
  options: SessionStoreListOptions,
): SessionStorePage {
  const normalized = normalizeSessionListOptions(options);
  const candidates = normalized.cursor
    ? sortedMetas.filter((meta) =>
        normalized.direction === 'forward'
          ? compareSessionMetaToCursor(
              meta,
              normalized.cursor as SessionCursorPayload,
            ) > 0
          : compareSessionMetaToCursor(
              meta,
              normalized.cursor as SessionCursorPayload,
            ) < 0,
      )
    : sortedMetas;
  const window =
    normalized.direction === 'backward'
      ? candidates.slice(Math.max(0, candidates.length - normalized.limit - 1))
      : candidates.slice(0, normalized.limit + 1);
  const hasMore = window.length > normalized.limit;
  const items =
    normalized.direction === 'backward'
      ? window.slice(hasMore ? 1 : 0)
      : window.slice(0, normalized.limit);

  return buildSessionStorePage(items, normalized, hasMore);
}

function buildSessionStorePage(
  items: SessionMeta[],
  options: NormalizedSessionListOptions,
  hasMore: boolean,
): SessionStorePage {
  if (items.length === 0) {
    return { items: [] };
  }

  const first = items[0] as SessionMeta;
  const last = items[items.length - 1] as SessionMeta;
  const page: SessionStorePage = { items };
  if (hasMore) {
    page.nextCursor = encodeSessionCursor(
      options.direction === 'forward' ? last : first,
      {
        ...options,
        direction: options.direction,
      },
    );
  }
  if (options.cursor) {
    page.previousCursor = encodeSessionCursor(
      options.direction === 'forward' ? first : last,
      {
        ...options,
        direction: options.direction === 'forward' ? 'backward' : 'forward',
      },
    );
  }
  return page;
}

function encodeSessionCursor(
  meta: SessionMeta,
  options: Pick<
    NormalizedSessionListOptions,
    'direction' | 'model' | 'provider' | 'tenantId'
  >,
): string {
  const payload: SessionCursorPayload = {
    direction: options.direction,
    key: {
      sessionId: meta.sessionId,
      tenantId: normalizeTenantId(meta.tenantId),
      updatedAt: normalizeCursorTimestamp(meta.updatedAt),
    },
    model: options.model ?? null,
    provider: options.provider ?? null,
    tenantId: options.tenantId ?? null,
    version: 1,
  };
  return encodeSessionCursorFromPayload(payload);
}

function decodeSessionCursor(
  encoded: string,
  options: NormalizedSessionListOptions,
): SessionCursorPayload {
  if (encoded.length === 0 || encoded.length > MAX_SESSION_CURSOR_LENGTH) {
    throw new InvalidSessionStoreListOptionsError('invalid_session_cursor');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(encoded));
  } catch {
    throw new InvalidSessionStoreListOptionsError('invalid_session_cursor');
  }
  if (
    !isPlainRecord(decoded) ||
    !hasExactKeys(decoded, ['d', 'k', 'm', 'p', 't', 'v'])
  ) {
    throw new InvalidSessionStoreListOptionsError('invalid_session_cursor');
  }
  const key = decoded.k;
  if (
    !isPlainRecord(key) ||
    !hasExactKeys(key, ['s', 't', 'u']) ||
    decoded.v !== 1 ||
    (decoded.d !== 'forward' && decoded.d !== 'backward') ||
    (decoded.m !== null && typeof decoded.m !== 'string') ||
    (decoded.p !== null &&
      !SESSION_PROVIDERS.includes(decoded.p as CanonicalProvider)) ||
    (decoded.t !== null && typeof decoded.t !== 'string') ||
    typeof key.s !== 'string' ||
    typeof key.t !== 'string' ||
    typeof key.u !== 'string' ||
    key.s.length > MAX_SESSION_FILTER_LENGTH ||
    key.t.length > MAX_SESSION_FILTER_LENGTH ||
    !isCursorTimestamp(key.u)
  ) {
    throw new InvalidSessionStoreListOptionsError('invalid_session_cursor');
  }
  const payload: SessionCursorPayload = {
    direction: decoded.d as SessionStoreListDirection,
    key: {
      sessionId: key.s as string,
      tenantId: key.t as string,
      updatedAt: key.u as string,
    },
    model: decoded.m as null | string,
    provider: decoded.p as CanonicalProvider | null,
    tenantId: decoded.t as null | string,
    version: 1,
  };
  if (
    payload.direction !== options.direction ||
    payload.model !== (options.model ?? null) ||
    payload.provider !== (options.provider ?? null) ||
    payload.tenantId !== (options.tenantId ?? null)
  ) {
    throw new InvalidSessionStoreListOptionsError('invalid_session_cursor');
  }
  if (encodeSessionCursorFromPayload(payload) !== encoded) {
    throw new InvalidSessionStoreListOptionsError('invalid_session_cursor');
  }
  return payload;
}

function encodeSessionCursorFromPayload(payload: SessionCursorPayload): string {
  return encodeBase64Url(
    JSON.stringify({
      d: payload.direction,
      k: {
        s: payload.key.sessionId,
        t: payload.key.tenantId,
        u: payload.key.updatedAt,
      },
      m: payload.model,
      p: payload.provider,
      t: payload.tenantId,
      v: payload.version,
    }),
  );
}

function compareSessionMeta(left: SessionMeta, right: SessionMeta): number {
  const updatedAt = compareUtf8(
    normalizeCursorTimestamp(left.updatedAt),
    normalizeCursorTimestamp(right.updatedAt),
  );
  if (updatedAt !== 0) {
    return -updatedAt;
  }
  const tenant = compareUtf8(
    normalizeTenantId(left.tenantId),
    normalizeTenantId(right.tenantId),
  );
  return tenant !== 0 ? tenant : compareUtf8(left.sessionId, right.sessionId);
}

function compareSessionMetaToCursor(
  meta: SessionMeta,
  cursor: SessionCursorPayload,
): number {
  const updatedAt = compareUtf8(
    normalizeCursorTimestamp(meta.updatedAt),
    cursor.key.updatedAt,
  );
  if (updatedAt !== 0) {
    return -updatedAt;
  }
  const tenant = compareUtf8(
    normalizeTenantId(meta.tenantId),
    cursor.key.tenantId,
  );
  return tenant !== 0
    ? tenant
    : compareUtf8(meta.sessionId, cursor.key.sessionId);
}

function normalizeCursorTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(
    value,
  );
  if (match) {
    return `${match[1]}.${(match[2] ?? '').padEnd(9, '0').slice(0, 9)}Z`;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? `${new Date(parsed).toISOString().slice(0, 19)}.${'0'.repeat(9)}Z`
    : value;
}

function isCursorTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(value);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftBytes[index] as number) - (rightBytes[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).join('\u0000') === keys.join('\u0000');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error('invalid base64url');
  }
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(bytes);
}

function buildPostgresSessionListQuery(
  tableName: string,
  options: SessionStoreListOptions,
  normalized?: NormalizedSessionListOptions,
): PostgresSessionListQuery {
  validateSessionListOptions(options);
  const values: unknown[] = [];
  const parameter = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const predicates: string[] = [];
  if (options.tenantId !== undefined) {
    predicates.push(
      `tenant_id = ${parameter(normalizeTenantId(options.tenantId))}`,
    );
  }
  if (options.model !== undefined) {
    predicates.push(`model = ${parameter(options.model)}`);
  }
  if (options.provider !== undefined) {
    predicates.push(`provider = ${parameter(options.provider)}`);
  }
  if (normalized?.cursor) {
    const cursorTime = parameter(normalized.cursor.key.updatedAt);
    const cursorTenant = parameter(normalized.cursor.key.tenantId);
    const cursorSession = parameter(normalized.cursor.key.sessionId);
    const comparison =
      normalized.direction === 'forward'
        ? `(updated_at < ${cursorTime}::timestamptz OR (updated_at = ${cursorTime}::timestamptz AND tenant_id COLLATE "C" > ${cursorTenant} COLLATE "C") OR (updated_at = ${cursorTime}::timestamptz AND tenant_id COLLATE "C" = ${cursorTenant} COLLATE "C" AND session_id COLLATE "C" > ${cursorSession} COLLATE "C"))`
        : `(updated_at > ${cursorTime}::timestamptz OR (updated_at = ${cursorTime}::timestamptz AND tenant_id COLLATE "C" < ${cursorTenant} COLLATE "C") OR (updated_at = ${cursorTime}::timestamptz AND tenant_id COLLATE "C" = ${cursorTenant} COLLATE "C" AND session_id COLLATE "C" < ${cursorSession} COLLATE "C"))`;
    predicates.push(comparison);
  }
  const where =
    predicates.length > 0 ? ` WHERE ${predicates.join(' AND ')}` : '';
  const order =
    normalized?.direction === 'backward'
      ? 'updated_at ASC, tenant_id COLLATE "C" DESC, session_id COLLATE "C" DESC'
      : 'updated_at DESC, tenant_id COLLATE "C" ASC, session_id COLLATE "C" ASC';
  const limit = normalized ? ` LIMIT ${parameter(normalized.limit + 1)}` : '';
  return {
    text: `SELECT session_id, tenant_id, message_count, model, provider, total_cost_usd, created_at, updated_at, version, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor FROM ${tableName}${where} ORDER BY ${order}${limit}`,
    values,
  };
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
  row: PostgresSessionStoreRow<TSnapshot> | PostgresSessionMetaRow,
): SessionMeta {
  return {
    createdAt: toIsoString(row.created_at),
    messageCount: row.message_count,
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    sessionId: row.session_id,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    totalCostUSD: Number(row.total_cost_usd),
    updatedAt:
      'updated_at_cursor' in row && row.updated_at_cursor !== undefined
        ? row.updated_at_cursor
        : toIsoString(row.updated_at),
    version: normalizeStoredVersion(row.version),
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

function validateExpectedVersion(version: number | undefined): void {
  if (
    version !== undefined &&
    (!Number.isSafeInteger(version) || version < 0)
  ) {
    throw new TypeError('expectedVersion must be a non-negative safe integer.');
  }
}

function normalizeStoredVersion(version: number | string | undefined): number {
  const normalized = version === undefined ? 1 : Number(version);
  return Number.isSafeInteger(normalized) && normalized >= 1 ? normalized : 1;
}

function versionMatches(
  storedVersion: number | undefined,
  expectedVersion: number,
  exists: boolean,
): boolean {
  if (expectedVersion === 0) {
    return !exists;
  }
  return exists && (storedVersion ?? 1) === expectedVersion;
}

function withSnapshotVersion<
  TSnapshot extends { messages: unknown[]; totalCostUSD: number },
>(snapshot: TSnapshot, version: number): TSnapshot {
  return { ...cloneValue(snapshot), version };
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

function parseRedisRecord<
  TSnapshot extends { messages: unknown[]; totalCostUSD: number },
>(raw: string): SessionRecord<TSnapshot> {
  const parsed = JSON.parse(raw) as SessionRecord<TSnapshot>;
  const record = cloneRecord(parsed);
  const version = normalizeStoredVersion(record.meta.version);
  record.meta.version = version;
  record.snapshot = withSnapshotVersion(record.snapshot, version);
  return record;
}

function normalizeRecordVersion<
  TSnapshot extends { messages: unknown[]; totalCostUSD: number },
>(record: SessionRecord<TSnapshot>): SessionRecord<TSnapshot> {
  const normalized = cloneRecord(record);
  const version = normalizeStoredVersion(normalized.meta.version);
  normalized.meta.version = version;
  normalized.snapshot = withSnapshotVersion(normalized.snapshot, version);
  return normalized;
}
