import { Pool } from 'pg';
export class ConsoleLogger {
    enabled;
    write;
    constructor(options = {}) {
        this.enabled = options.enabled ?? process.env.NODE_ENV !== 'production';
        this.write = options.write ?? ((message) => console.info(message));
    }
    log(event) {
        if (!this.enabled) {
            return;
        }
        this.write(`llm-usage ${JSON.stringify(event)}`);
    }
}
/**
 * Batched Postgres-backed usage logger that can also aggregate usage totals.
 *
 * @example
 * ```ts
 * const logger = PostgresUsageLogger.fromEnv();
 * await logger.log(event);
 * const summary = await logger.getUsage({ sessionId: 'demo' });
 * ```
 */
export class PostgresUsageLogger {
    batchSize;
    connectionString;
    ensureSchemaPromise = null;
    flushIntervalMs;
    flushPromise = null;
    flushTimer;
    internalPool;
    onError;
    pool;
    queue = [];
    schemaName;
    tableName;
    constructor(options = {}) {
        this.batchSize = options.batchSize ?? 25;
        this.connectionString = options.connectionString;
        this.flushIntervalMs = options.flushIntervalMs ?? 1000;
        this.onError =
            options.onError ??
                ((error) => console.error('PostgresUsageLogger flush failed.', error));
        this.pool = options.pool;
        this.schemaName = options.schemaName ?? 'public';
        this.tableName = options.tableName ?? 'llm_usage_events';
    }
    static fromEnv(options = {}) {
        return new PostgresUsageLogger({
            ...options,
            ...(process.env.DATABASE_URL
                ? { connectionString: process.env.DATABASE_URL }
                : {}),
        });
    }
    async close() {
        clearScheduledFlush(this);
        await this.flush().catch(() => undefined);
        if (!this.internalPool?.end) {
            return;
        }
        await this.internalPool.end();
        this.internalPool = undefined;
        this.ensureSchemaPromise = null;
    }
    async ensureSchema() {
        if (this.ensureSchemaPromise) {
            await this.ensureSchemaPromise;
            return;
        }
        this.ensureSchemaPromise = (async () => {
            const pool = this.getPool();
            await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`);
            await pool.query(`CREATE TABLE IF NOT EXISTS ${this.qualifiedTableName()} (
          id BIGSERIAL PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cached_tokens INTEGER NOT NULL,
          cached_read_tokens INTEGER NOT NULL DEFAULT 0,
          cached_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd DOUBLE PRECISION NOT NULL,
          finish_reason TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '',
          session_id TEXT,
          bot_id TEXT,
          routing_decision TEXT
        )`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_tenant_timestamp_idx`)} ON ${this.qualifiedTableName()} (tenant_id, timestamp DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_session_timestamp_idx`)} ON ${this.qualifiedTableName()} (session_id, timestamp DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_provider_model_timestamp_idx`)} ON ${this.qualifiedTableName()} (provider, model, timestamp DESC)`);
        })();
        try {
            await this.ensureSchemaPromise;
        }
        catch (error) {
            this.ensureSchemaPromise = null;
            throw error;
        }
    }
    async flush() {
        if (this.flushPromise) {
            return this.flushPromise;
        }
        if (this.queue.length === 0) {
            return;
        }
        clearScheduledFlush(this);
        const batch = this.queue.splice(0, this.queue.length);
        this.flushPromise = this.flushBatch(batch).finally(() => {
            this.flushPromise = null;
            if (this.queue.length > 0) {
                scheduleFlush(this);
            }
        });
        return this.flushPromise;
    }
    async getUsage(query = {}) {
        await this.flush().catch(() => undefined);
        await this.ensureSchema();
        const { conditions, values } = buildUsageFilters(query);
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await this.getPool().query(`SELECT
         provider,
         model,
         COUNT(*) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd
       FROM ${this.qualifiedTableName()}
       ${whereClause}
       GROUP BY provider, model
       ORDER BY provider ASC, model ASC`, values);
        const breakdown = result.rows.map((row) => ({
            model: row.model,
            provider: row.provider,
            requestCount: Number(row.request_count),
            totalCachedTokens: Number(row.total_cached_tokens),
            totalCostUSD: Number(row.total_cost_usd),
            totalInputTokens: Number(row.total_input_tokens),
            totalOutputTokens: Number(row.total_output_tokens),
        }));
        return breakdown.reduce((summary, row) => {
            summary.breakdown.push(row);
            summary.requestCount += row.requestCount;
            summary.totalCachedTokens += row.totalCachedTokens;
            summary.totalCostUSD += row.totalCostUSD;
            summary.totalInputTokens += row.totalInputTokens;
            summary.totalOutputTokens += row.totalOutputTokens;
            return summary;
        }, {
            breakdown: [],
            requestCount: 0,
            totalCachedTokens: 0,
            totalCostUSD: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
        });
    }
    async log(event) {
        this.queue.push(cloneUsageEvent(event));
        if (this.queue.length >= this.batchSize) {
            return this.flush();
        }
        scheduleFlush(this);
    }
    async flushBatch(batch) {
        if (batch.length === 0) {
            return;
        }
        try {
            await this.ensureSchema();
            const columns = [
                'timestamp',
                'provider',
                'model',
                'input_tokens',
                'output_tokens',
                'cached_tokens',
                'cached_read_tokens',
                'cached_write_tokens',
                'cost_usd',
                'finish_reason',
                'duration_ms',
                'tenant_id',
                'session_id',
                'bot_id',
                'routing_decision',
            ];
            const values = [];
            const placeholders = batch.map((event, index) => {
                const offset = index * columns.length;
                values.push(event.timestamp, event.provider, event.model, event.inputTokens, event.outputTokens, event.cachedTokens, event.cachedReadTokens ?? 0, event.cachedWriteTokens ?? 0, event.costUSD, event.finishReason, event.durationMs, normalizeTenantId(event.tenantId), event.sessionId ?? null, event.botId ?? null, event.routingDecision ?? null);
                return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`;
            });
            await this.getPool().query(`INSERT INTO ${this.qualifiedTableName()} (${columns.join(', ')})
         VALUES ${placeholders.join(', ')}`, values);
        }
        catch (error) {
            this.queue = [...batch, ...this.queue];
            this.onError(error);
            throw error;
        }
    }
    getPool() {
        if (this.pool) {
            return this.pool;
        }
        if (this.internalPool) {
            return this.internalPool;
        }
        if (!this.connectionString) {
            throw new Error('DATABASE_URL is required for PostgresUsageLogger.');
        }
        this.internalPool = new Pool({
            connectionString: this.connectionString,
        });
        return this.internalPool;
    }
    qualifiedTableName() {
        return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(this.tableName)}`;
    }
}
function buildUsageFilters(query) {
    const conditions = [];
    const values = [];
    if (query.tenantId !== undefined) {
        values.push(normalizeTenantId(query.tenantId));
        conditions.push(`tenant_id = $${values.length}`);
    }
    if (query.sessionId !== undefined) {
        values.push(query.sessionId);
        conditions.push(`session_id = $${values.length}`);
    }
    if (query.provider !== undefined) {
        values.push(query.provider);
        conditions.push(`provider = $${values.length}`);
    }
    if (query.model !== undefined) {
        values.push(query.model);
        conditions.push(`model = $${values.length}`);
    }
    if (query.botId !== undefined) {
        values.push(query.botId);
        conditions.push(`bot_id = $${values.length}`);
    }
    if (query.since !== undefined) {
        values.push(query.since);
        conditions.push(`timestamp >= $${values.length}`);
    }
    if (query.until !== undefined) {
        values.push(query.until);
        conditions.push(`timestamp <= $${values.length}`);
    }
    return { conditions, values };
}
function clearScheduledFlush(logger) {
    if (!logger['flushTimer']) {
        return;
    }
    clearTimeout(logger['flushTimer']);
    logger['flushTimer'] = undefined;
}
function cloneUsageEvent(event) {
    return {
        ...event,
    };
}
function normalizeTenantId(tenantId) {
    return tenantId ?? '';
}
function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function scheduleFlush(logger) {
    if (logger['flushTimer'] || logger['flushIntervalMs'] <= 0) {
        return;
    }
    logger['flushTimer'] = setTimeout(() => {
        logger['flushTimer'] = undefined;
        void logger.flush().catch(() => undefined);
    }, logger['flushIntervalMs']);
}
