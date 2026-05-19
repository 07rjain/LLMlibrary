import type { CanonicalProvider, SpeechProvider, SpeechUsageMetrics, UsageEvent } from './types.js';
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
export interface SpeechUsageQuery {
    botId?: string;
    kind?: 'speech' | 'transcription';
    model?: string;
    provider?: SpeechProvider;
    sessionId?: string;
    since?: string;
    tenantId?: string;
    until?: string;
}
export interface SpeechUsageBreakdown {
    kind: 'speech' | 'transcription';
    model: string;
    provider: SpeechProvider;
    requestCount: number;
    totalAudioInputSeconds: number;
    totalAudioOutputSeconds: number;
    totalCostUSD: number;
    totalInputCharacters: number;
    totalInputTokens: number;
    totalOutputCharacters: number;
    totalOutputTokens: number;
}
export interface SpeechUsageSummary {
    breakdown: SpeechUsageBreakdown[];
    requestCount: number;
    totalAudioInputSeconds: number;
    totalAudioOutputSeconds: number;
    totalCostUSD: number;
    totalInputCharacters: number;
    totalInputTokens: number;
    totalOutputCharacters: number;
    totalOutputTokens: number;
}
export interface SpeechUsageEvent {
    botId?: string;
    durationMs: number;
    kind: 'speech' | 'transcription';
    model: string;
    provider: SpeechProvider;
    sessionId?: string;
    speechUsage: SpeechUsageMetrics;
    tenantId?: string;
    timestamp: string;
}
export type UsageExportFormat = 'csv' | 'json';
/** Contract for development and persistent usage logging backends. */
export interface UsageLogger {
    close?(): Promise<void>;
    flush?(): Promise<void>;
    getSpeechUsage?(query?: SpeechUsageQuery): Promise<SpeechUsageSummary>;
    getUsage?(query?: UsageQuery): Promise<UsageSummary>;
    log(event: UsageEvent): Promise<void> | void;
    logSpeech?(event: SpeechUsageEvent): Promise<void> | void;
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
    logSpeech(event: SpeechUsageEvent): void;
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
    private speechQueue;
    private readonly schemaName;
    private readonly tableName;
    constructor(options?: PostgresUsageLoggerOptions);
    static fromEnv(options?: Omit<PostgresUsageLoggerOptions, 'connectionString'>): PostgresUsageLogger;
    close(): Promise<void>;
    ensureSchema(): Promise<void>;
    flush(): Promise<void>;
    getUsage(query?: UsageQuery): Promise<UsageSummary>;
    getSpeechUsage(query?: SpeechUsageQuery): Promise<SpeechUsageSummary>;
    log(event: UsageEvent): Promise<void>;
    logSpeech(event: SpeechUsageEvent): Promise<void>;
    private flushBatch;
    private flushSpeechBatch;
    private getPool;
    private qualifiedTableName;
    private speechQualifiedTableName;
}
export type { PostgresSessionStorePool, PostgresSessionStoreQueryResult };
/** Serializes aggregated usage into either JSON or CSV output. */
export declare function exportUsageSummary(summary: UsageSummary, format: UsageExportFormat): string;
/** Serializes aggregated speech usage into either JSON or CSV output. */
export declare function exportSpeechUsageSummary(summary: SpeechUsageSummary, format: UsageExportFormat): string;
//# sourceMappingURL=usage.d.ts.map