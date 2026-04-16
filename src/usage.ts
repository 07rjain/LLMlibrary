import { loadPgPoolConstructor } from './node-pg-loader.js';
import { sanitizeForLogging } from './redaction.js';
import { getEnvironmentVariable, isProductionRuntime } from './runtime.js';

import type { CanonicalProvider, UsageEvent } from './types.js';
import type {
  PostgresSessionStorePool,
  PostgresSessionStoreQueryResult,
} from './session-store.js';

/** Filter options for usage aggregation queries. */
export interface UsageQuery {
  botId?: string;
  model?: string;
  provider?: CanonicalProvider;
  sessionId?: string;
  since?: string;
  tenantId?: string;
  until?: string;
}

/** Per-provider and per-model usage aggregate. */
export interface UsageBreakdown {
  model: string;
  provider: CanonicalProvider;
  requestCount: number;
  totalCachedTokens: number;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Aggregate usage totals returned by `client.getUsage()`. */
export interface UsageSummary {
  breakdown: UsageBreakdown[];
  requestCount: number;
  totalCachedTokens: number;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export type UsageExportFormat = 'csv' | 'json';

/** Contract for development and persistent usage logging backends. */
export interface UsageLogger {
  close?(): Promise<void>;
  flush?(): Promise<void>;
  getUsage?(query?: UsageQuery): Promise<UsageSummary>;
  log(event: UsageEvent): Promise<void> | void;
}

/** Configuration for the console usage logger. */
export interface ConsoleLoggerOptions {
  enabled?: boolean;
  write?: (message: string) => void;
}

/** Configuration for the Postgres usage logger. */
export interface PostgresUsageLoggerOptions {
  batchSize?: number;
  connectionString?: string;
  flushIntervalMs?: number;
  onError?: (error: unknown) => void;
  pool?: PostgresSessionStorePool;
  schemaName?: string;
  tableName?: string;
}

interface PostgresUsageSummaryRow {
  model: string;
  provider: CanonicalProvider;
  request_count: number | string;
  total_cached_tokens: number | string;
  total_cost_usd: number | string;
  total_input_tokens: number | string;
  total_output_tokens: number | string;
}

export class ConsoleLogger implements UsageLogger {
  private readonly enabled: boolean;
  private readonly write: (message: string) => void;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.enabled = options.enabled ?? !isProductionRuntime();
    this.write = options.write ?? ((message) => console.info(message));
  }

  log(event: UsageEvent): void {
    if (!this.enabled) {
      return;
    }

    this.write(`llm-usage ${JSON.stringify(sanitizeForLogging(event))}`);
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
export class PostgresUsageLogger implements UsageLogger {
  private readonly batchSize: number;
  private readonly connectionString: string | undefined;
  private ensureSchemaPromise: null | Promise<void> = null;
  private flushIntervalMs: number;
  private flushPromise: null | Promise<void> = null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private internalPool: PostgresSessionStorePool | undefined;
  private readonly onError: (error: unknown) => void;
  private readonly pool: PostgresSessionStorePool | undefined;
  private queue: UsageEvent[] = [];
  private readonly schemaName: string;
  private readonly tableName: string;

  constructor(options: PostgresUsageLoggerOptions = {}) {
    this.batchSize = options.batchSize ?? 25;
    this.connectionString = options.connectionString;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.onError =
      options.onError ??
      ((error) =>
        console.error(
          'PostgresUsageLogger flush failed.',
          sanitizeForLogging(error),
        ));
    this.pool = options.pool;
    this.schemaName = options.schemaName ?? 'public';
    this.tableName = options.tableName ?? 'llm_usage_events';
  }

  static fromEnv(
    options: Omit<PostgresUsageLoggerOptions, 'connectionString'> = {},
  ): PostgresUsageLogger {
    const connectionString = getEnvironmentVariable('DATABASE_URL');
    return new PostgresUsageLogger({
      ...options,
      ...(connectionString ? { connectionString } : {}),
    });
  }

  async close(): Promise<void> {
    clearScheduledFlush(this);
    await this.flush().catch(() => undefined);

    if (!this.internalPool?.end) {
      return;
    }

    await this.internalPool.end();
    this.internalPool = undefined;
    this.ensureSchemaPromise = null;
  }

  async ensureSchema(): Promise<void> {
    if (this.ensureSchemaPromise) {
      await this.ensureSchemaPromise;
      return;
    }

    this.ensureSchemaPromise = (async () => {
      const pool = await this.getPool();
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`);
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.qualifiedTableName()} (
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
        )`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(
          `${this.tableName}_tenant_timestamp_idx`,
        )} ON ${this.qualifiedTableName()} (tenant_id, timestamp DESC)`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(
          `${this.tableName}_session_timestamp_idx`,
        )} ON ${this.qualifiedTableName()} (session_id, timestamp DESC)`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(
          `${this.tableName}_provider_model_timestamp_idx`,
        )} ON ${this.qualifiedTableName()} (provider, model, timestamp DESC)`,
      );
    })();

    try {
      await this.ensureSchemaPromise;
    } catch (error) {
      this.ensureSchemaPromise = null;
      throw error;
    }
  }

  async flush(): Promise<void> {
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

  async getUsage(query: UsageQuery = {}): Promise<UsageSummary> {
    await this.flush().catch(() => undefined);
    await this.ensureSchema();

    const { conditions, values } = buildUsageFilters(query);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const pool = await this.getPool();
    const result = await pool.query<PostgresUsageSummaryRow>(
      `SELECT
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
       ORDER BY provider ASC, model ASC`,
      values,
    );

    const breakdown = result.rows.map((row) => ({
      model: row.model,
      provider: row.provider,
      requestCount: Number(row.request_count),
      totalCachedTokens: Number(row.total_cached_tokens),
      totalCostUSD: Number(row.total_cost_usd),
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
    }));

    return breakdown.reduce<UsageSummary>(
      (summary, row) => {
        summary.breakdown.push(row);
        summary.requestCount += row.requestCount;
        summary.totalCachedTokens += row.totalCachedTokens;
        summary.totalCostUSD += row.totalCostUSD;
        summary.totalInputTokens += row.totalInputTokens;
        summary.totalOutputTokens += row.totalOutputTokens;
        return summary;
      },
      {
        breakdown: [],
        requestCount: 0,
        totalCachedTokens: 0,
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    );
  }

  async log(event: UsageEvent): Promise<void> {
    this.queue.push(cloneUsageEvent(event));

    if (this.queue.length >= this.batchSize) {
      return this.flush();
    }

    scheduleFlush(this);
  }

  private async flushBatch(batch: UsageEvent[]): Promise<void> {
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
      const values: unknown[] = [];
      const placeholders = batch.map((event, index) => {
        const offset = index * columns.length;
        values.push(
          event.timestamp,
          event.provider,
          event.model,
          event.inputTokens,
          event.outputTokens,
          event.cachedTokens,
          event.cachedReadTokens ?? 0,
          event.cachedWriteTokens ?? 0,
          event.costUSD,
          event.finishReason,
          event.durationMs,
          normalizeTenantId(event.tenantId),
          event.sessionId ?? null,
          event.botId ?? null,
          event.routingDecision ?? null,
        );
        return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(', ')})`;
      });

      const pool = await this.getPool();
      await pool.query(
        `INSERT INTO ${this.qualifiedTableName()} (${columns.join(', ')})
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    } catch (error) {
      this.queue = [...batch, ...this.queue];
      this.onError(error);
      throw error;
    }
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
      throw new Error('DATABASE_URL is required for PostgresUsageLogger.');
    }

    const Pool = await loadPgPoolConstructor();
    this.internalPool = new Pool({
      connectionString,
    });
    return this.internalPool;
  }

  private qualifiedTableName(): string {
    return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(this.tableName)}`;
  }
}

function buildUsageFilters(query: UsageQuery): {
  conditions: string[];
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];

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

function clearScheduledFlush(logger: PostgresUsageLogger): void {
  if (!logger['flushTimer']) {
    return;
  }

  clearTimeout(logger['flushTimer']);
  logger['flushTimer'] = undefined;
}

function cloneUsageEvent(event: UsageEvent): UsageEvent {
  return {
    ...event,
  };
}

function normalizeTenantId(tenantId: string | undefined): string {
  return tenantId ?? '';
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function scheduleFlush(logger: PostgresUsageLogger): void {
  if (logger['flushTimer'] || logger['flushIntervalMs'] <= 0) {
    return;
  }

  logger['flushTimer'] = setTimeout(() => {
    logger['flushTimer'] = undefined;
    void logger.flush().catch(() => undefined);
  }, logger['flushIntervalMs']);
}

export type { PostgresSessionStorePool, PostgresSessionStoreQueryResult };

/** Serializes aggregated usage into either JSON or CSV output. */
export function exportUsageSummary(
  summary: UsageSummary,
  format: UsageExportFormat,
): string {
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
      'totalCachedTokens',
      'totalCostUSD',
    ].join(','),
  ];

  for (const row of summary.breakdown) {
    lines.push(
      [
        row.provider,
        row.model,
        row.requestCount,
        row.totalInputTokens,
        row.totalOutputTokens,
        row.totalCachedTokens,
        row.totalCostUSD.toFixed(6),
      ]
        .map((value) => escapeCsvField(String(value)))
        .join(','),
    );
  }

  return lines.join('\n');
}

function escapeCsvField(value: string): string {
  if (!/[",\n]/.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '""')}"`;
}
