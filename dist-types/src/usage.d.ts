import type { CanonicalProvider, UsageEvent } from './types.js';
import type { PostgresSessionStorePool, PostgresSessionStoreQueryResult } from './session-store.js';
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
export declare class ConsoleLogger implements UsageLogger {
    private readonly enabled;
    private readonly write;
    constructor(options?: ConsoleLoggerOptions);
    log(event: UsageEvent): void;
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
export declare class PostgresUsageLogger implements UsageLogger {
    private readonly batchSize;
    private readonly connectionString;
    private ensureSchemaPromise;
    private flushIntervalMs;
    private flushPromise;
    private flushTimer;
    private internalPool;
    private readonly onError;
    private readonly pool;
    private queue;
    private readonly schemaName;
    private readonly tableName;
    constructor(options?: PostgresUsageLoggerOptions);
    static fromEnv(options?: Omit<PostgresUsageLoggerOptions, 'connectionString'>): PostgresUsageLogger;
    close(): Promise<void>;
    ensureSchema(): Promise<void>;
    flush(): Promise<void>;
    getUsage(query?: UsageQuery): Promise<UsageSummary>;
    log(event: UsageEvent): Promise<void>;
    private flushBatch;
    private getPool;
    private qualifiedTableName;
}
export type { PostgresSessionStorePool, PostgresSessionStoreQueryResult };
//# sourceMappingURL=usage.d.ts.map