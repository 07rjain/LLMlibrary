import { loadPgPoolConstructor } from './node-pg-loader.js';
import { getEnvironmentVariable } from './runtime.js';
/** Simple in-process store intended for tests and single-process development. */
export class InMemorySessionStore {
    now;
    records = new Map();
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
    }
    async delete(sessionId, tenantId) {
        this.records.delete(buildSessionKey(sessionId, tenantId));
    }
    async get(sessionId, tenantId) {
        const record = this.records.get(buildSessionKey(sessionId, tenantId));
        if (!record) {
            return null;
        }
        return cloneRecord(record);
    }
    async list(options = {}) {
        return [...this.records.values()]
            .filter((record) => options.tenantId === undefined ? true : record.meta.tenantId === options.tenantId)
            .map((record) => cloneMeta(record.meta))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    async set(sessionId, snapshot, options = {}) {
        const key = buildSessionKey(sessionId, options.tenantId);
        const existing = this.records.get(key);
        const timestamp = this.now().toISOString();
        const meta = {
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
        const record = {
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
export class PostgresSessionStore {
    connectionString;
    ensureSchemaPromise = null;
    internalPool;
    now;
    pool;
    schemaName;
    tableName;
    constructor(options = {}) {
        this.connectionString = options.connectionString;
        this.now = options.now ?? (() => new Date());
        this.pool = options.pool;
        this.schemaName = options.schemaName ?? 'public';
        this.tableName = options.tableName ?? 'llm_sessions';
    }
    static fromEnv(options = {}) {
        const connectionString = getEnvironmentVariable('DATABASE_URL');
        return new PostgresSessionStore({
            ...options,
            ...(connectionString ? { connectionString } : {}),
        });
    }
    async close() {
        if (!this.internalPool?.end) {
            return;
        }
        await this.internalPool.end();
        this.internalPool = undefined;
        this.ensureSchemaPromise = null;
    }
    async delete(sessionId, tenantId) {
        await this.ensureSchema();
        const pool = await this.getPool();
        await pool.query(`DELETE FROM ${this.qualifiedTableName()} WHERE tenant_id = $1 AND session_id = $2`, [normalizeTenantId(tenantId), sessionId]);
    }
    async get(sessionId, tenantId) {
        await this.ensureSchema();
        const pool = await this.getPool();
        const result = await pool.query(`SELECT session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at
       FROM ${this.qualifiedTableName()}
       WHERE tenant_id = $1 AND session_id = $2
       LIMIT 1`, [normalizeTenantId(tenantId), sessionId]);
        const row = result.rows[0];
        if (!row) {
            return null;
        }
        return mapPostgresRecord(row);
    }
    async list(options = {}) {
        await this.ensureSchema();
        const filterByTenant = options.tenantId !== undefined;
        const pool = await this.getPool();
        const result = await pool.query(`SELECT session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at
       FROM ${this.qualifiedTableName()}
       ${filterByTenant ? 'WHERE tenant_id = $1' : ''}
       ORDER BY updated_at DESC`, filterByTenant ? [normalizeTenantId(options.tenantId)] : []);
        return result.rows.map((row) => mapPostgresMeta(row));
    }
    async set(sessionId, snapshot, options = {}) {
        await this.ensureSchema();
        const timestamp = this.now().toISOString();
        const tenantId = normalizeTenantId(options.tenantId);
        const pool = await this.getPool();
        const result = await pool.query(`INSERT INTO ${this.qualifiedTableName()} (
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
       RETURNING session_id, tenant_id, snapshot, message_count, model, provider, total_cost_usd, created_at, updated_at`, [
            tenantId,
            sessionId,
            JSON.stringify(snapshot),
            snapshot.messages.length,
            options.model ?? null,
            options.provider ?? null,
            snapshot.totalCostUSD,
            options.createdAt ?? timestamp,
            timestamp,
        ]);
        const row = result.rows[0];
        if (!row) {
            throw new Error('Postgres session upsert did not return a row.');
        }
        return mapPostgresRecord(row);
    }
    async ensureSchema() {
        if (!this.ensureSchemaPromise) {
            this.ensureSchemaPromise = this.runEnsureSchema();
        }
        await this.ensureSchemaPromise;
    }
    qualifiedTableName() {
        return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(this.tableName)}`;
    }
    async getPool() {
        if (this.pool) {
            return this.pool;
        }
        if (this.internalPool) {
            return this.internalPool;
        }
        const connectionString = this.connectionString ?? getEnvironmentVariable('DATABASE_URL');
        if (!connectionString) {
            throw new Error('DATABASE_URL is required for PostgresSessionStore. Set it in .env or pass connectionString explicitly.');
        }
        const Pool = await loadPgPoolConstructor();
        const pool = new Pool({
            connectionString,
        });
        this.internalPool = pool;
        return pool;
    }
    async runEnsureSchema() {
        const pool = await this.getPool();
        const qualifiedTableName = this.qualifiedTableName();
        const updatedAtIndexName = quoteIdentifier(`${this.tableName}_tenant_updated_at_idx`);
        const snapshotIndexName = quoteIdentifier(`${this.tableName}_snapshot_gin_idx`);
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (
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
       )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${updatedAtIndexName}
       ON ${qualifiedTableName} (tenant_id, updated_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${snapshotIndexName}
       ON ${qualifiedTableName} USING GIN (snapshot)`);
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
export class RedisSessionStore {
    client;
    keyPrefix;
    now;
    scanCount;
    ttlSeconds;
    constructor(options) {
        this.client = options.client;
        this.keyPrefix = options.keyPrefix ?? 'llm:sessions';
        this.now = options.now ?? (() => new Date());
        this.scanCount = options.scanCount ?? 100;
        this.ttlSeconds = options.ttlSeconds;
    }
    async delete(sessionId, tenantId) {
        await this.client.del(this.key(sessionId, tenantId));
    }
    async get(sessionId, tenantId) {
        const raw = await this.client.get(this.key(sessionId, tenantId));
        if (!raw) {
            return null;
        }
        return parseRedisRecord(raw);
    }
    async list(options = {}) {
        const records = [];
        for await (const key of this.iterateKeys()) {
            const raw = await this.client.get(key);
            if (!raw) {
                continue;
            }
            const record = parseRedisRecord(raw);
            if (options.tenantId !== undefined &&
                normalizeTenantId(record.meta.tenantId) !== normalizeTenantId(options.tenantId)) {
                continue;
            }
            records.push(record.meta);
        }
        return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    async set(sessionId, snapshot, options = {}) {
        const existing = await this.get(sessionId, options.tenantId);
        const timestamp = this.now().toISOString();
        const meta = {
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
        const record = {
            meta,
            snapshot: cloneValue(snapshot),
        };
        await this.client.set(this.key(sessionId, options.tenantId), JSON.stringify(record), buildRedisSetOptions(this.ttlSeconds));
        return cloneRecord(record);
    }
    key(sessionId, tenantId) {
        return `${this.keyPrefix}:${normalizeTenantId(tenantId)}:${sessionId}`;
    }
    async *iterateKeys() {
        const pattern = `${this.keyPrefix}:*`;
        if (this.client.scanIterator) {
            for await (const key of this.client.scanIterator({
                COUNT: this.scanCount,
                MATCH: pattern,
            })) {
                yield key;
            }
            return;
        }
        if (this.client.keys) {
            for (const key of await this.client.keys(pattern)) {
                yield key;
            }
            return;
        }
        throw new Error('RedisSessionStore client must implement scanIterator() or keys() for list().');
    }
}
function buildSessionKey(sessionId, tenantId) {
    return `${tenantId ?? 'default'}:${sessionId}`;
}
function mapPostgresRecord(row) {
    return {
        meta: mapPostgresMeta(row),
        snapshot: cloneValue(row.snapshot),
    };
}
function mapPostgresMeta(row) {
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
function normalizeTenantId(tenantId) {
    return tenantId ?? '';
}
function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }
    return new Date(value).toISOString();
}
function cloneRecord(record) {
    return {
        meta: cloneMeta(record.meta),
        snapshot: cloneValue(record.snapshot),
    };
}
function cloneMeta(meta) {
    return { ...meta };
}
function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}
function buildRedisSetOptions(ttlSeconds) {
    if (ttlSeconds === undefined) {
        return undefined;
    }
    return {
        EX: ttlSeconds,
    };
}
function parseRedisRecord(raw) {
    const parsed = JSON.parse(raw);
    return cloneRecord(parsed);
}
