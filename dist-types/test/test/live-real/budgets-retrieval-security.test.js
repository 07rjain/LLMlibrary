import { describe, expect, it } from 'vitest';
import { LLMClient } from '../../src/client.js';
import { BudgetExceededError, LLMError } from '../../src/errors.js';
import { createDenseRetriever, createInMemoryKnowledgeStore, createPgvectorHnswIndexSql, createPostgresKnowledgeStore, } from '../../src/retrieval.js';
import { PostgresSessionStore } from '../../src/session-store.js';
import { ConsoleLogger, PostgresUsageLogger } from '../../src/usage.js';
import { calcCostUSD } from '../../src/utils/cost.js';
import { expectNoSecretLeak, hasEnv, liveClient, liveRealEnabled, providerModels, requireLiveEnv, runId, } from './helpers.js';
const liveDescribe = liveRealEnabled ? describe : describe.skip;
liveDescribe('live-real budgets, usage, retrieval, stores, and security', () => {
    it('logs live usage and calculates OpenAI costs consistently', async () => {
        requireLiveEnv('OPENAI_API_KEY');
        const events = [];
        const client = LLMClient.fromEnv({
            retryOptions: { maxAttempts: 2 },
            usageLogger: {
                log: (event) => {
                    events.push(event);
                },
            },
        });
        const response = await client.complete({
            botId: runId('bot'),
            maxTokens: 16,
            messages: [{ content: 'Reply with exactly: USAGE_LOG_OK', role: 'user' }],
            model: providerModels.openai,
            provider: 'openai',
            sessionId: runId('usage_session'),
            temperature: 0,
            tenantId: runId('tenant'),
        });
        expect(response.text).toContain('USAGE_LOG_OK');
        expect(events).toHaveLength(1);
        expect(events[0]?.inputTokens).toBe(response.usage.inputTokens);
        expect(events[0]?.costUSD).toBe(response.usage.costUSD);
        expect(calcCostUSD({
            ...(response.usage.cachedReadTokens !== undefined
                ? { cachedReadTokens: response.usage.cachedReadTokens }
                : {}),
            inputTokens: response.usage.inputTokens,
            model: providerModels.openai,
            outputTokens: response.usage.outputTokens,
        })).toBeCloseTo(response.usage.costUSD, 9);
    }, 120_000);
    it('preflights request budgets including Gemini thinking budget', async () => {
        requireLiveEnv('GEMINI_API_KEY');
        const client = liveClient();
        await expect(client.complete({
            budgetUsd: 0,
            maxTokens: 16,
            messages: [{ content: 'This must not reach Gemini.', role: 'user' }],
            model: providerModels.geminiThinking,
            provider: 'google',
            providerOptions: {
                google: {
                    thinking: {
                        budgetTokens: 128,
                    },
                },
            },
        })).rejects.toBeInstanceOf(BudgetExceededError);
    });
    it('embeds documents with Gemini and searches an isolated in-memory RAG store', async () => {
        requireLiveEnv('GEMINI_API_KEY');
        const run = runId('rag');
        const tenantId = `${run}_tenant`;
        const botId = `${run}_bot`;
        const spaceId = `${run}_space`;
        const profileId = `${run}_profile`;
        const sourceId = `${run}_source`;
        const client = liveClient();
        const store = createInMemoryKnowledgeStore();
        await store.upsertKnowledgeSpace({
            botId,
            id: spaceId,
            name: 'Live real knowledge',
            tenantId,
        });
        await store.upsertEmbeddingProfile({
            botId,
            dimensions: 768,
            id: profileId,
            knowledgeSpaceId: spaceId,
            model: 'gemini-embedding-2',
            provider: 'google',
            tenantId,
        });
        await store.activateEmbeddingProfile({
            botId,
            embeddingProfileId: profileId,
            knowledgeSpaceId: spaceId,
            tenantId,
        });
        await store.upsertKnowledgeSource({
            botId,
            embeddingProfileId: profileId,
            id: sourceId,
            knowledgeSpaceId: spaceId,
            name: 'live-real-source',
            sourceType: 'test',
            status: 'ready',
            tenantId,
            title: 'Live Real Source',
        });
        const documentEmbedding = await client.embed({
            dimensions: 768,
            input: 'Factory Droid live-real tests validate tenant isolation.',
            model: 'gemini-embedding-2',
            provider: 'google',
            purpose: 'retrieval_document',
            tenantId,
        });
        await store.upsertKnowledgeChunk({
            botId,
            chunkIndex: 0,
            embedding: documentEmbedding.embeddings[0].values,
            embeddingProfileId: profileId,
            id: `${run}_chunk`,
            knowledgeSpaceId: spaceId,
            sourceId,
            sourceName: 'live-real-source',
            tenantId,
            text: 'Factory Droid live-real tests validate tenant isolation.',
            title: 'Tenant isolation',
        });
        await expect(store.searchByEmbedding({
            limit: 1,
            queryEmbedding: documentEmbedding.embeddings[0].values,
        })).rejects.toThrow(/requires a retrieval filter/);
        const retriever = createDenseRetriever({
            embed: client,
            embedding: {
                dimensions: 768,
                model: 'gemini-embedding-2',
                provider: 'google',
            },
            store,
        });
        const results = await retriever.search({
            filter: { botId, knowledgeSpaceId: spaceId, tenantId },
            query: 'tenant isolation validation',
            topK: 1,
        });
        expect(results[0]?.text).toContain('tenant isolation');
        const unfilteredStore = createInMemoryKnowledgeStore({
            allowUnfilteredSearch: true,
        });
        expect(await unfilteredStore.searchByEmbedding({
            limit: 1,
            queryEmbedding: [1, 0, 0],
        })).toEqual([]);
    }, 90_000);
    it('validates Postgres session tenant isolation when DATABASE_URL is present', async () => {
        if (!hasEnv('DATABASE_URL')) {
            throw new Error('DATABASE_URL is required to validate PostgresSessionStore.');
        }
        const run = runId('pg_session');
        const store = PostgresSessionStore.fromEnv({
            tableName: `llm_sessions_${run}`,
        });
        const sessionId = `${run}_session`;
        const tenantA = `${run}_tenant_a`;
        const tenantB = `${run}_tenant_b`;
        const snapshot = baseSnapshot(sessionId);
        try {
            await store.ensureSchema();
            await store.set(sessionId, snapshot, { tenantId: tenantA });
            expect(await store.get(sessionId, tenantA)).not.toBeNull();
            expect(await store.get(sessionId, tenantB)).toBeNull();
            const updated = {
                ...snapshot,
                messages: [{ content: 'updated', role: 'user' }],
                totalCostUSD: 0.001,
            };
            await store.set(sessionId, updated, { tenantId: tenantA });
            const listedA = await store.list({ tenantId: tenantA });
            const listedB = await store.list({ tenantId: tenantB });
            expect(listedA.some((item) => item.sessionId === sessionId)).toBe(true);
            expect(listedB.some((item) => item.sessionId === sessionId)).toBe(false);
            await store.delete(sessionId, tenantA);
            expect(await store.get(sessionId, tenantA)).toBeNull();
        }
        finally {
            await store.close();
        }
    }, 60_000);
    it('validates pgvector dimension rejection before SQL generation', () => {
        expect(() => createPgvectorHnswIndexSql({
            dimensions: 16_001,
            embeddingProfileId: 'profile_bad',
        })).toThrow(/dimensions/i);
        expect(() => createPgvectorHnswIndexSql({
            dimensions: Number.NaN,
            embeddingProfileId: 'profile_bad',
        })).toThrow(/dimensions/i);
        const sql = createPgvectorHnswIndexSql({
            dimensions: 3,
            embeddingProfileId: 'profile_ok',
        });
        expect(sql).toContain('vector(3)');
        expect(sql).not.toContain('16001');
    });
    it('validates Postgres RAG store setup when DATABASE_URL is present', async () => {
        if (!hasEnv('DATABASE_URL')) {
            throw new Error('DATABASE_URL is required to validate PostgresKnowledgeStore.');
        }
        const run = runId('pg_rag');
        const store = createPostgresKnowledgeStore({
            schemaName: `rag_${run}`,
            tableNames: {
                chunks: `chunks_${run}`,
                profiles: `profiles_${run}`,
                sources: `sources_${run}`,
                spaces: `spaces_${run}`,
            },
        });
        try {
            await store.ensureSchema();
            await expect(store.searchByEmbedding({
                limit: 1,
                queryEmbedding: [1, 2, 3],
            })).rejects.toThrow(/retrieval filter/);
        }
        finally {
            await store.close();
        }
    }, 60_000);
    it('blocks unsafe transcription URL fetches before provider calls', async () => {
        const blockedUrls = [
            'http://localhost/audio.wav',
            'http://127.0.0.1/audio.wav',
            'http://0.0.0.0/audio.wav',
            'http://10.0.0.1/audio.wav',
            'http://172.16.0.1/audio.wav',
            'http://192.168.0.1/audio.wav',
            'http://[::1]/audio.wav',
            'http://[fd00::1]/audio.wav',
            'http://[fe80::1]/audio.wav',
            'http://[::ffff:127.0.0.1]/audio.wav',
            'https://private-host.test/audio.wav',
        ];
        const client = new LLMClient({
            fetchImplementation: async () => {
                throw new Error('Provider fetch must not be reached for blocked URLs.');
            },
            openaiApiKey: 'sk-live-real-placeholder',
        });
        for (const url of blockedUrls) {
            const policy = {
                blockPrivateNetworks: true,
                enabled: true,
                ...(url.includes('private-host.test')
                    ? { resolveHostname: () => ['127.0.0.1'] }
                    : {}),
            };
            await expect(client.transcribe({
                input: {
                    mediaType: 'audio/wav',
                    url,
                },
                transcriptionUrlPolicy: policy,
            })).rejects.toThrow(/blocked|private|localhost|allowed/i);
        }
    });
    it('redacts secrets in usage logs and provider error surfaces', async () => {
        const writes = [];
        const logger = new ConsoleLogger({
            enabled: true,
            write: (message) => writes.push(message),
        });
        await logger.log({
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            durationMs: 1,
            finishReason: 'stop',
            inputTokens: 1,
            model: 'gpt-4o-mini',
            outputTokens: 1,
            provider: 'openai',
            timestamp: new Date().toISOString(),
            tenantId: process.env.OPENAI_API_KEY ?? 'tenant',
        });
        expectNoSecretLeak(writes);
        const client = liveClient();
        try {
            await client.complete({
                maxTokens: 8,
                messages: [{ content: 'This should fail.', role: 'user' }],
                model: 'not-a-real-openai-model-live-real',
                provider: 'openai',
            });
        }
        catch (error) {
            expectNoSecretLeak(error);
            expect(error).toBeInstanceOf(LLMError);
            return;
        }
        throw new Error('Expected invalid model request to fail.');
    }, 30_000);
    it('aggregates reasoning tokens in Postgres usage when DATABASE_URL is present', async () => {
        if (!hasEnv('DATABASE_URL')) {
            throw new Error('DATABASE_URL is required to validate PostgresUsageLogger.');
        }
        const run = runId('pg_usage');
        const logger = PostgresUsageLogger.fromEnv({
            batchSize: 1,
            tableName: `llm_usage_${run}`,
        });
        try {
            await logger.log({
                cachedTokens: 0,
                cost: '$0.01',
                costUSD: 0.01,
                durationMs: 1,
                finishReason: 'stop',
                inputTokens: 10,
                model: providerModels.gemini,
                outputTokens: 3,
                provider: 'google',
                reasoningTokens: 7,
                sessionId: run,
                tenantId: run,
                timestamp: new Date().toISOString(),
            });
            await logger.flush();
            const usage = await logger.getUsage({ sessionId: run, tenantId: run });
            expect(usage.totalReasoningTokens).toBe(7);
            expect(usage.totalCostUSD).toBeCloseTo(0.01, 9);
        }
        finally {
            await logger.close();
        }
    }, 60_000);
});
function baseSnapshot(sessionId) {
    const timestamp = new Date().toISOString();
    return {
        createdAt: timestamp,
        messages: [{ content: 'hello', role: 'user' }],
        sessionId,
        totalCachedTokens: 0,
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        updatedAt: timestamp,
    };
}
