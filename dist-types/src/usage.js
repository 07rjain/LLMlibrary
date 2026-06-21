import { loadPgPoolConstructor } from './node-pg-loader.js';
import { sanitizeForLogging } from './redaction.js';
import { getEnvironmentVariable, isProductionRuntime } from './runtime.js';
export class ConsoleLogger {
    enabled;
    write;
    constructor(options = {}) {
        this.enabled = options.enabled ?? !isProductionRuntime();
        this.write = options.write ?? ((message) => console.info(message));
    }
    log(event) {
        if (!this.enabled) {
            return;
        }
        this.write(`llm-usage ${JSON.stringify(sanitizeForLogging(event))}`);
    }
    logSpeech(event) {
        if (!this.enabled) {
            return;
        }
        this.write(`llm-speech-usage ${JSON.stringify(sanitizeForLogging(event))}`);
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
    speechQueue = [];
    schemaName;
    tableName;
    constructor(options = {}) {
        this.batchSize = options.batchSize ?? 25;
        this.connectionString = options.connectionString;
        this.flushIntervalMs = options.flushIntervalMs ?? 1000;
        this.onError =
            options.onError ??
                ((error) => console.error('PostgresUsageLogger flush failed.', sanitizeForLogging(error)));
        this.pool = options.pool;
        this.schemaName = options.schemaName ?? 'public';
        this.tableName = options.tableName ?? 'llm_usage_events';
    }
    static fromEnv(options = {}) {
        const connectionString = getEnvironmentVariable('DATABASE_URL');
        return new PostgresUsageLogger({
            ...options,
            ...(connectionString ? { connectionString } : {}),
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
            const pool = await this.getPool();
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
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd DOUBLE PRECISION NOT NULL,
          finish_reason TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '',
          session_id TEXT,
          bot_id TEXT,
          routing_decision TEXT
        )`);
            await pool.query(`ALTER TABLE ${this.qualifiedTableName()}
         ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER NOT NULL DEFAULT 0`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_tenant_timestamp_idx`)} ON ${this.qualifiedTableName()} (tenant_id, timestamp DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_session_timestamp_idx`)} ON ${this.qualifiedTableName()} (session_id, timestamp DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_provider_model_timestamp_idx`)} ON ${this.qualifiedTableName()} (provider, model, timestamp DESC)`);
            await pool.query(`CREATE TABLE IF NOT EXISTS ${this.speechQualifiedTableName()} (
          id BIGSERIAL PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          kind TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          audio_input_tokens INTEGER NOT NULL DEFAULT 0,
          audio_output_tokens INTEGER NOT NULL DEFAULT 0,
          input_audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
          output_audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
          input_characters INTEGER NOT NULL DEFAULT 0,
          output_characters INTEGER NOT NULL DEFAULT 0,
          cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          estimated BOOLEAN NOT NULL DEFAULT FALSE,
          cost_breakdown_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          duration_ms INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '',
          session_id TEXT,
          bot_id TEXT
        )`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_speech_tenant_timestamp_idx`)} ON ${this.speechQualifiedTableName()} (tenant_id, timestamp DESC)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableName}_speech_provider_model_timestamp_idx`)} ON ${this.speechQualifiedTableName()} (provider, model, timestamp DESC)`);
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
        if (this.queue.length === 0 && this.speechQueue.length === 0) {
            return;
        }
        clearScheduledFlush(this);
        const batch = this.queue.splice(0, this.queue.length);
        const speechBatch = this.speechQueue.splice(0, this.speechQueue.length);
        this.flushPromise = (async () => {
            try {
                await this.flushBatch(batch);
                await this.flushSpeechBatch(speechBatch);
            }
            finally {
                this.flushPromise = null;
                if (this.speechQueue.length > 0 || this.queue.length > 0) {
                    scheduleFlush(this);
                }
            }
        })();
        return this.flushPromise;
    }
    async getUsage(query = {}) {
        await this.flush().catch(() => undefined);
        await this.ensureSchema();
        const { conditions, values } = buildUsageFilters(query);
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const pool = await this.getPool();
        const result = await pool.query(`SELECT
         provider,
         model,
         COUNT(*) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens,
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
            totalReasoningTokens: Number(row.total_reasoning_tokens),
        }));
        return breakdown.reduce((summary, row) => {
            summary.breakdown.push(row);
            summary.requestCount += row.requestCount;
            summary.totalCachedTokens += row.totalCachedTokens;
            summary.totalCostUSD += row.totalCostUSD;
            summary.totalInputTokens += row.totalInputTokens;
            summary.totalOutputTokens += row.totalOutputTokens;
            summary.totalReasoningTokens = (summary.totalReasoningTokens ?? 0) + (row.totalReasoningTokens ?? 0);
            return summary;
        }, {
            breakdown: [],
            requestCount: 0,
            totalCachedTokens: 0,
            totalCostUSD: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalReasoningTokens: 0,
        });
    }
    async getSpeechUsage(query = {}) {
        await this.flush().catch(() => undefined);
        await this.ensureSchema();
        const { conditions, values } = buildSpeechUsageFilters(query);
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const pool = await this.getPool();
        const result = await pool.query(`SELECT
         provider,
         model,
         kind,
         COUNT(*) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(input_audio_seconds), 0) AS total_audio_input_seconds,
         COALESCE(SUM(output_audio_seconds), 0) AS total_audio_output_seconds,
         COALESCE(SUM(input_characters), 0) AS total_input_characters,
         COALESCE(SUM(output_characters), 0) AS total_output_characters,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd
       FROM ${this.speechQualifiedTableName()}
       ${whereClause}
       GROUP BY provider, model, kind
       ORDER BY provider ASC, model ASC, kind ASC`, values);
        const breakdown = result.rows.map((row) => ({
            kind: row.kind,
            model: row.model,
            provider: row.provider,
            requestCount: Number(row.request_count),
            totalAudioInputSeconds: Number(row.total_audio_input_seconds),
            totalAudioOutputSeconds: Number(row.total_audio_output_seconds),
            totalCostUSD: Number(row.total_cost_usd),
            totalInputCharacters: Number(row.total_input_characters),
            totalInputTokens: Number(row.total_input_tokens),
            totalOutputCharacters: Number(row.total_output_characters),
            totalOutputTokens: Number(row.total_output_tokens),
        }));
        return breakdown.reduce((summary, row) => {
            summary.breakdown.push(row);
            summary.requestCount += row.requestCount;
            summary.totalAudioInputSeconds += row.totalAudioInputSeconds;
            summary.totalAudioOutputSeconds += row.totalAudioOutputSeconds;
            summary.totalCostUSD += row.totalCostUSD;
            summary.totalInputCharacters += row.totalInputCharacters;
            summary.totalInputTokens += row.totalInputTokens;
            summary.totalOutputCharacters += row.totalOutputCharacters;
            summary.totalOutputTokens += row.totalOutputTokens;
            return summary;
        }, {
            breakdown: [],
            requestCount: 0,
            totalAudioInputSeconds: 0,
            totalAudioOutputSeconds: 0,
            totalCostUSD: 0,
            totalInputCharacters: 0,
            totalInputTokens: 0,
            totalOutputCharacters: 0,
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
    async logSpeech(event) {
        this.speechQueue.push(cloneSpeechUsageEvent(event));
        if (this.speechQueue.length >= this.batchSize) {
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
                'reasoning_tokens',
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
                values.push(event.timestamp, event.provider, event.model, event.inputTokens, event.outputTokens, event.cachedTokens, event.cachedReadTokens ?? 0, event.cachedWriteTokens ?? 0, event.reasoningTokens ?? 0, event.costUSD, event.finishReason, event.durationMs, normalizeTenantId(event.tenantId), event.sessionId ?? null, event.botId ?? null, event.routingDecision ?? null);
                return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`;
            });
            const pool = await this.getPool();
            await pool.query(`INSERT INTO ${this.qualifiedTableName()} (${columns.join(', ')})
         VALUES ${placeholders.join(', ')}`, values);
        }
        catch (error) {
            this.queue = [...batch, ...this.queue];
            this.onError(error);
            throw error;
        }
    }
    async flushSpeechBatch(batch) {
        if (batch.length === 0) {
            return;
        }
        try {
            await this.ensureSchema();
            const columns = [
                'timestamp',
                'provider',
                'model',
                'kind',
                'input_tokens',
                'output_tokens',
                'audio_input_tokens',
                'audio_output_tokens',
                'input_audio_seconds',
                'output_audio_seconds',
                'input_characters',
                'output_characters',
                'cost_usd',
                'estimated',
                'cost_breakdown_json',
                'duration_ms',
                'tenant_id',
                'session_id',
                'bot_id',
            ];
            const values = [];
            const placeholders = batch.map((event, index) => {
                const offset = index * columns.length;
                const usage = event.speechUsage;
                values.push(event.timestamp, event.provider, event.model, event.kind, usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.audioInputTokens ?? usage.billingUnits?.audioInputTokens ?? 0, usage.audioOutputTokens ?? usage.billingUnits?.audioOutputTokens ?? 0, usage.inputAudioSeconds ?? usage.billingUnits?.inputAudioSeconds ?? 0, usage.outputAudioSeconds ?? usage.billingUnits?.outputAudioSeconds ?? 0, usage.inputCharacters ?? usage.billingUnits?.inputCharacters ?? 0, usage.outputCharacters ?? usage.billingUnits?.outputCharacters ?? 0, usage.costUSD ?? 0, usage.estimated ?? false, JSON.stringify(usage.costBreakdown ?? []), event.durationMs, normalizeTenantId(event.tenantId), event.sessionId ?? null, event.botId ?? null);
                return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`;
            });
            const pool = await this.getPool();
            await pool.query(`INSERT INTO ${this.speechQualifiedTableName()} (${columns.join(', ')})
         VALUES ${placeholders.join(', ')}`, values);
        }
        catch (error) {
            this.speechQueue = [...batch, ...this.speechQueue];
            this.onError(error);
            throw error;
        }
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
            throw new Error('DATABASE_URL is required for PostgresUsageLogger.');
        }
        const Pool = await loadPgPoolConstructor();
        this.internalPool = new Pool({
            connectionString,
        });
        return this.internalPool;
    }
    qualifiedTableName() {
        return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(this.tableName)}`;
    }
    speechQualifiedTableName() {
        return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(`${this.tableName}_speech`)}`;
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
function buildSpeechUsageFilters(query) {
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
    if (query.kind !== undefined) {
        values.push(query.kind);
        conditions.push(`kind = $${values.length}`);
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
function cloneSpeechUsageEvent(event) {
    return {
        ...event,
        speechUsage: {
            ...event.speechUsage,
            ...(event.speechUsage.billingUnits
                ? { billingUnits: { ...event.speechUsage.billingUnits } }
                : {}),
            ...(event.speechUsage.costBreakdown
                ? { costBreakdown: event.speechUsage.costBreakdown.map((line) => ({ ...line })) }
                : {}),
        },
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
/** Serializes aggregated usage into either JSON or CSV output. */
export function exportUsageSummary(summary, format) {
    if (format === 'json') {
        return JSON.stringify(summary, null, 2);
    }
    const lines = [
        [
            'provider',
            'model',
            'requestCount',
            'totalInputTokens',
            'totalOutputTokens',
            'totalReasoningTokens',
            'totalCachedTokens',
            'totalCostUSD',
        ].join(','),
    ];
    for (const row of summary.breakdown) {
        lines.push([
            row.provider,
            row.model,
            row.requestCount,
            row.totalInputTokens,
            row.totalOutputTokens,
            row.totalReasoningTokens ?? 0,
            row.totalCachedTokens,
            row.totalCostUSD.toFixed(6),
        ]
            .map((value) => escapeCsvField(String(value)))
            .join(','));
    }
    return lines.join('\n');
}
/** Serializes aggregated speech usage into either JSON or CSV output. */
export function exportSpeechUsageSummary(summary, format) {
    if (format === 'json') {
        return JSON.stringify(summary, null, 2);
    }
    const lines = [
        [
            'provider',
            'model',
            'kind',
            'requestCount',
            'totalInputTokens',
            'totalOutputTokens',
            'totalInputCharacters',
            'totalOutputCharacters',
            'totalAudioInputSeconds',
            'totalAudioOutputSeconds',
            'totalCostUSD',
        ].join(','),
    ];
    for (const row of summary.breakdown) {
        lines.push([
            row.provider,
            row.model,
            row.kind,
            row.requestCount,
            row.totalInputTokens,
            row.totalOutputTokens,
            row.totalInputCharacters,
            row.totalOutputCharacters,
            row.totalAudioInputSeconds,
            row.totalAudioOutputSeconds,
            row.totalCostUSD.toFixed(6),
        ]
            .map((value) => escapeCsvField(String(value)))
            .join(','));
    }
    return lines.join('\n');
}
function escapeCsvField(value) {
    if (!/[",\n]/.test(value)) {
        return value;
    }
    return `"${value.replaceAll('"', '""')}"`;
}
