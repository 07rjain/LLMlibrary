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
import { ConsoleLogger, PostgresUsageLogger, } from '../src/usage.js';
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
                },
            ],
            requestCount: 2,
            totalCachedTokens: 0,
            totalCostUSD: 0.03,
            totalInputTokens: 30,
            totalOutputTokens: 12,
        });
    });
    it('flushes queued usage events on a timer and closes env-backed pools', async () => {
        vi.useFakeTimers();
        process.env.DATABASE_URL = 'postgresql://example.test/usage';
        try {
            const logger = PostgresUsageLogger.fromEnv({
                batchSize: 10,
                flushIntervalMs: 5,
            });
            await logger.log(buildUsageEvent({ sessionId: 'timer-session' }));
            expect(createdPools).toHaveLength(0);
            await vi.advanceTimersByTimeAsync(5);
            expect(pgMockState.poolConstructor).toHaveBeenCalledWith({
                connectionString: 'postgresql://example.test/usage',
            });
            expect(createdPools[0]?.queries.at(-1)?.text).toContain('INSERT INTO "public"."llm_usage_events"');
            await logger.close();
            expect(createdPools[0]?.end).toHaveBeenCalledTimes(1);
        }
        finally {
            vi.useRealTimers();
        }
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
