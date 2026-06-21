import { beforeEach, describe, expect, it, vi } from 'vitest';
const pgMockState = vi.hoisted(() => {
    return {
        createdPools: [],
        poolConstructor: vi.fn(),
    };
});
vi.mock('pg', () => {
    return {
        Pool: pgMockState.poolConstructor,
    };
});
import { ConsoleLogger, PostgresUsageLogger, exportSpeechUsageSummary, exportUsageSummary, } from '../src/usage.js';
const createdPools = pgMockState.createdPools;
describe('Usage logging', () => {
    beforeEach(() => {
        createdPools.length = 0;
        pgMockState.poolConstructor.mockClear();
        pgMockState.poolConstructor.mockImplementation((options) => {
            const pool = new MockPool(options);
            createdPools.push(pool);
            return pool;
        });
        delete process.env.DATABASE_URL;
    });
    it('writes console usage logs only when enabled', () => {
        const write = vi.fn();
        const logger = new ConsoleLogger({
            enabled: true,
            write,
        });
        const disabledLogger = new ConsoleLogger({
            enabled: false,
            write,
        });
        logger.log(buildUsageEvent());
        disabledLogger.log(buildUsageEvent());
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]?.[0]).toContain('llm-usage');
    });
    it('redacts credential-like fields from console logs', () => {
        const write = vi.fn();
        const logger = new ConsoleLogger({
            enabled: true,
            write,
        });
        logger.log({
            ...buildUsageEvent(),
            model: 'gpt-4o',
            sessionId: 'session-1',
            // @ts-expect-error test redaction of unexpected fields
            metadata: { authorization: 'Bearer sk-secret-value' },
        });
        expect(write.mock.calls[0]?.[0]).toContain('"authorization":"[REDACTED]"');
        expect(write.mock.calls[0]?.[0]).not.toContain('sk-secret-value');
    });
    it('batches Postgres usage writes and aggregates usage summaries', async () => {
        const pool = new MockPool();
        const logger = new PostgresUsageLogger({
            batchSize: 2,
            flushIntervalMs: 0,
            pool,
            schemaName: 'llm',
            tableName: 'usage_events',
        });
        await logger.log(buildUsageEvent({ sessionId: 'session-1' }));
        expect(pool.queries).toHaveLength(0);
        await logger.log(buildUsageEvent({
            costUSD: 0.02,
            inputTokens: 20,
            outputTokens: 8,
            sessionId: 'session-2',
        }));
        expect(pool.queries[0]?.text).toContain('CREATE SCHEMA IF NOT EXISTS "llm"');
        expect(pool.queries[1]?.text).toContain('CREATE TABLE IF NOT EXISTS "llm"."usage_events"');
        expect(pool.queries.at(-1)?.text).toContain('INSERT INTO "llm"."usage_events"');
        pool.queueRows([
            {
                model: 'gpt-4o',
                provider: 'openai',
                request_count: '2',
                total_cached_tokens: '0',
                total_cost_usd: '0.03',
                total_input_tokens: '30',
                total_output_tokens: '12',
                total_reasoning_tokens: '5',
            },
        ]);
        const summary = await logger.getUsage({ tenantId: 'tenant-1' });
        expect(pool.queries.at(-1)?.text).toContain('GROUP BY provider, model');
        expect(pool.queries.at(-1)?.values).toEqual(['tenant-1']);
        expect(summary).toEqual({
            breakdown: [
                {
                    model: 'gpt-4o',
                    provider: 'openai',
                    requestCount: 2,
                    totalCachedTokens: 0,
                    totalCostUSD: 0.03,
                    totalInputTokens: 30,
                    totalOutputTokens: 12,
                    totalReasoningTokens: 5,
                },
            ],
            requestCount: 2,
            totalCachedTokens: 0,
            totalCostUSD: 0.03,
            totalInputTokens: 30,
            totalOutputTokens: 12,
            totalReasoningTokens: 5,
        });
    });
    it('batches Postgres speech usage writes and aggregates speech summaries', async () => {
        const pool = new MockPool();
        const logger = new PostgresUsageLogger({
            batchSize: 2,
            flushIntervalMs: 0,
            pool,
            schemaName: 'llm',
            tableName: 'usage_events',
        });
        await logger.logSpeech(buildSpeechUsageEvent({
            sessionId: 'speech-1',
            speechUsage: {
                billingUnits: {
                    inputCharacters: 12,
                    outputAudioSeconds: 4,
                },
                cost: '$0.001',
                costBreakdown: [
                    {
                        amountUSD: 0.001,
                        estimated: true,
                        label: 'Output audio duration',
                        quantity: 4,
                        rateUSD: 0.00025,
                        unit: 'audio_second',
                    },
                ],
                costUSD: 0.001,
                inputCharacters: 12,
                inputTokens: 3,
                outputAudioSeconds: 4,
            },
        }));
        expect(pool.queries).toHaveLength(0);
        await logger.logSpeech(buildSpeechUsageEvent({
            kind: 'transcription',
            model: 'gpt-4o-mini-transcribe',
            sessionId: 'speech-2',
            speechUsage: {
                cost: '$0.0001',
                costUSD: 0.0001,
                inputAudioSeconds: 2,
                outputCharacters: 11,
                outputTokens: 3,
            },
        }));
        expect(pool.queries.some((query) => query.text.includes('CREATE TABLE IF NOT EXISTS "llm"."usage_events_speech"'))).toBe(true);
        expect(pool.queries.at(-1)?.text).toContain('INSERT INTO "llm"."usage_events_speech"');
        pool.queueRows([
            {
                kind: 'speech',
                model: 'gpt-4o-mini-tts',
                provider: 'openai',
                request_count: '1',
                total_audio_input_seconds: '0',
                total_audio_output_seconds: '4',
                total_cost_usd: '0.001',
                total_input_characters: '12',
                total_input_tokens: '3',
                total_output_characters: '0',
                total_output_tokens: '0',
            },
        ]);
        const summary = await logger.getSpeechUsage({ kind: 'speech', tenantId: 'tenant-1' });
        expect(pool.queries.at(-1)?.text).toContain('GROUP BY provider, model, kind');
        expect(pool.queries.at(-1)?.values).toEqual(['tenant-1', 'speech']);
        expect(summary).toEqual({
            breakdown: [
                {
                    kind: 'speech',
                    model: 'gpt-4o-mini-tts',
                    provider: 'openai',
                    requestCount: 1,
                    totalAudioInputSeconds: 0,
                    totalAudioOutputSeconds: 4,
                    totalCostUSD: 0.001,
                    totalInputCharacters: 12,
                    totalInputTokens: 3,
                    totalOutputCharacters: 0,
                    totalOutputTokens: 0,
                },
            ],
            requestCount: 1,
            totalAudioInputSeconds: 0,
            totalAudioOutputSeconds: 4,
            totalCostUSD: 0.001,
            totalInputCharacters: 12,
            totalInputTokens: 3,
            totalOutputCharacters: 0,
            totalOutputTokens: 0,
        });
    });
    it('flushes queued usage events on a timer', async () => {
        vi.useFakeTimers();
        const pool = new MockPool();
        try {
            const logger = new PostgresUsageLogger({
                batchSize: 10,
                flushIntervalMs: 5,
                pool,
            });
            await logger.log(buildUsageEvent({ sessionId: 'timer-session' }));
            expect(pool.queries).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(5);
            expect(pool.queries.at(-1)?.text).toContain('INSERT INTO "public"."llm_usage_events"');
            await logger.close();
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('captures DATABASE_URL through fromEnv()', () => {
        process.env.DATABASE_URL = 'postgresql://example.test/usage';
        const logger = PostgresUsageLogger.fromEnv();
        expect(logger.connectionString).toBe('postgresql://example.test/usage');
    });
    it('requeues failed flushes and applies all usage filters', async () => {
        const onError = vi.fn();
        const pool = new MockPool();
        pool.failNextInsert = true;
        const logger = new PostgresUsageLogger({
            batchSize: 1,
            flushIntervalMs: 0,
            onError,
            pool,
        });
        await expect(logger.log(buildUsageEvent({
            botId: 'bot-1',
            model: 'gpt-4o-mini',
            provider: 'openai',
            sessionId: 'session-filtered',
        }))).rejects.toThrow('insert failed');
        expect(onError).toHaveBeenCalled();
        await logger.flush();
        pool.queueRows([
            {
                model: 'gpt-4o-mini',
                provider: 'openai',
                request_count: '1',
                total_cached_tokens: '0',
                total_cost_usd: '0.01',
                total_input_tokens: '10',
                total_output_tokens: '4',
                total_reasoning_tokens: '2',
            },
        ]);
        await logger.getUsage({
            botId: 'bot-1',
            model: 'gpt-4o-mini',
            provider: 'openai',
            sessionId: 'session-filtered',
            since: '2026-04-15T00:00:00.000Z',
            tenantId: 'tenant-1',
            until: '2026-04-16T00:00:00.000Z',
        });
        expect(pool.queries.at(-1)?.values).toEqual([
            'tenant-1',
            'session-filtered',
            'openai',
            'gpt-4o-mini',
            'bot-1',
            '2026-04-15T00:00:00.000Z',
            '2026-04-16T00:00:00.000Z',
        ]);
    });
    it('throws when DATABASE_URL is missing for PostgresUsageLogger', async () => {
        const logger = new PostgresUsageLogger();
        await expect(logger.ensureSchema()).rejects.toThrow('DATABASE_URL is required for PostgresUsageLogger.');
    });
    it('exports aggregated usage as JSON and CSV', () => {
        const summary = {
            breakdown: [
                {
                    model: 'gpt,4o',
                    provider: 'openai',
                    requestCount: 2,
                    totalCachedTokens: 4,
                    totalCostUSD: 0.03,
                    totalInputTokens: 20,
                    totalOutputTokens: 8,
                    totalReasoningTokens: 3,
                },
            ],
            requestCount: 2,
            totalCachedTokens: 4,
            totalCostUSD: 0.03,
            totalInputTokens: 20,
            totalOutputTokens: 8,
            totalReasoningTokens: 3,
        };
        expect(exportUsageSummary(summary, 'json')).toContain('"requestCount": 2');
        expect(exportUsageSummary(summary, 'csv')).toContain('provider,model,requestCount,totalInputTokens,totalOutputTokens,totalReasoningTokens,totalCachedTokens,totalCostUSD');
        expect(exportUsageSummary(summary, 'csv')).toContain('openai,"gpt,4o",2,20,8,3,4,0.030000');
    });
    it('exports aggregated speech usage as JSON and CSV', () => {
        const summary = {
            breakdown: [
                {
                    kind: 'speech',
                    model: 'gpt-4o-mini,tts',
                    provider: 'openai',
                    requestCount: 1,
                    totalAudioInputSeconds: 0,
                    totalAudioOutputSeconds: 3,
                    totalCostUSD: 0.001,
                    totalInputCharacters: 12,
                    totalInputTokens: 3,
                    totalOutputCharacters: 0,
                    totalOutputTokens: 0,
                },
            ],
            requestCount: 1,
            totalAudioInputSeconds: 0,
            totalAudioOutputSeconds: 3,
            totalCostUSD: 0.001,
            totalInputCharacters: 12,
            totalInputTokens: 3,
            totalOutputCharacters: 0,
            totalOutputTokens: 0,
        };
        expect(exportSpeechUsageSummary(summary, 'json')).toContain('"requestCount": 1');
        expect(exportSpeechUsageSummary(summary, 'csv')).toContain('provider,model,kind,requestCount,totalInputTokens,totalOutputTokens,totalInputCharacters,totalOutputCharacters,totalAudioInputSeconds,totalAudioOutputSeconds,totalCostUSD');
        expect(exportSpeechUsageSummary(summary, 'csv')).toContain('openai,"gpt-4o-mini,tts",speech,1,3,0,12,0,0,3,0.001000');
    });
});
class MockPool {
    end = vi.fn(async () => undefined);
    failNextInsert = false;
    options;
    queries = [];
    responses = [];
    constructor(options) {
        this.options = options;
    }
    queueRows(rows) {
        this.responses.push({ rows });
    }
    async query(text, values = []) {
        const normalizedText = text.replace(/\s+/g, ' ').trim();
        this.queries.push({
            text: normalizedText,
            values,
        });
        if (/^INSERT\b/i.test(normalizedText) && this.failNextInsert) {
            this.failNextInsert = false;
            throw new Error('insert failed');
        }
        if (!/^(INSERT|SELECT)\b/i.test(normalizedText) || this.responses.length === 0) {
            return { rows: [] };
        }
        return this.responses.shift();
    }
}
function buildUsageEvent(overrides = {}) {
    return {
        cachedTokens: 0,
        cost: '$0.01',
        costUSD: 0.01,
        durationMs: 120,
        finishReason: 'stop',
        inputTokens: 10,
        model: 'gpt-4o',
        outputTokens: 4,
        provider: 'openai',
        tenantId: 'tenant-1',
        timestamp: '2026-04-15T10:00:00.000Z',
        ...overrides,
    };
}
function buildSpeechUsageEvent(overrides = {}) {
    return {
        durationMs: 120,
        kind: 'speech',
        model: 'gpt-4o-mini-tts',
        provider: 'openai',
        speechUsage: {
            cost: '$0.001',
            costUSD: 0.001,
            inputCharacters: 12,
            inputTokens: 3,
            outputAudioSeconds: 4,
        },
        tenantId: 'tenant-1',
        timestamp: '2026-04-15T10:00:00.000Z',
        ...overrides,
    };
}
