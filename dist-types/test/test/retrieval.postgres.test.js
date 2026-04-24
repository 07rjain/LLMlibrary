import { beforeEach, describe, expect, it, vi } from 'vitest';
const pgMockState = vi.hoisted(() => {
    return {
        poolConstructor: vi.fn(),
    };
});
vi.mock('pg', () => {
    return {
        Pool: pgMockState.poolConstructor,
    };
});
import { LLMError } from '../src/errors.js';
import { createPgvectorHnswIndexSql, createPostgresKnowledgeStore, PostgresKnowledgeStore, } from '../src/retrieval.js';
class MockPgPool {
    queries = [];
    responder;
    constructor(responder = () => ({
        rowCount: 0,
        rows: [],
    })) {
        this.responder = responder;
    }
    async query(text, values) {
        this.queries.push({
            text,
            ...(values ? { values } : {}),
        });
        const result = await this.responder(text, values);
        return result;
    }
}
describe('PostgresKnowledgeStore', () => {
    beforeEach(() => {
        pgMockState.poolConstructor.mockReset();
    });
    it('bootstraps the pgvector schema and indexes', async () => {
        const pool = new MockPgPool();
        const store = new PostgresKnowledgeStore({ pool });
        await store.ensureSchema();
        expect(pool.queries[0]?.text).toContain('CREATE EXTENSION IF NOT EXISTS vector');
        expect(pool.queries.some((query) => query.text.includes('"public"."knowledge_spaces"'))).toBe(true);
        expect(pool.queries.some((query) => query.text.includes('"public"."knowledge_chunks"'))).toBe(true);
        expect(pool.queries.some((query) => query.text.includes('"knowledge_chunks_search_document_idx"'))).toBe(true);
        expect(pool.queries.some((query) => query.text.includes('active_embedding_profile_id'))).toBe(true);
    });
    it('can skip extension creation when the database is already prepared', async () => {
        const pool = new MockPgPool();
        const store = new PostgresKnowledgeStore({
            ensureVectorExtension: false,
            pool,
        });
        await store.ensureSchema();
        expect(pool.queries.some((query) => query.text.includes('CREATE EXTENSION'))).toBe(false);
    });
    it('upserts knowledge records and serializes vectors/citations', async () => {
        const pool = new MockPgPool();
        const store = createPostgresKnowledgeStore({ pool });
        await store.upsertKnowledgeSpace({
            botId: 'bot-1',
            id: 'space-1',
            name: 'Support KB',
            tenantId: 'tenant-1',
        });
        await store.upsertEmbeddingProfile({
            botId: 'bot-1',
            dimensions: 768,
            id: 'profile-1',
            knowledgeSpaceId: 'space-1',
            model: 'gemini-embedding-2',
            provider: 'google',
            tenantId: 'tenant-1',
        });
        await store.upsertKnowledgeSource({
            botId: 'bot-1',
            id: 'source-1',
            knowledgeSpaceId: 'space-1',
            name: 'Refund Policy PDF',
            sourceType: 'pdf',
            tenantId: 'tenant-1',
            title: 'Refund Policy',
        });
        const chunk = await store.upsertKnowledgeChunk({
            botId: 'bot-1',
            chunkIndex: 0,
            embedding: [0.12, 0.34, 0.56],
            embeddingProfileId: 'profile-1',
            id: 'chunk-1',
            knowledgeSpaceId: 'space-1',
            metadata: { locale: 'en' },
            sourceId: 'source-1',
            sourceName: 'Refund Policy PDF',
            sourceType: 'pdf',
            tenantId: 'tenant-1',
            text: 'Refunds are available for 30 days.',
            title: 'Refund Policy',
            url: 'https://example.test/refunds.pdf',
        });
        const lastQuery = pool.queries.at(-1);
        const serializedCitation = JSON.parse(String(lastQuery?.values?.[8]));
        expect(lastQuery?.text).toContain('INSERT INTO "public"."knowledge_chunks"');
        expect(lastQuery?.values).toContain('[0.12,0.34,0.56]');
        expect(serializedCitation).toMatchObject({
            chunkId: 'chunk-1',
            metadata: { locale: 'en' },
            sourceId: 'source-1',
            sourceName: 'Refund Policy PDF',
            title: 'Refund Policy',
            url: 'https://example.test/refunds.pdf',
        });
        expect(chunk.scopeType).toBe('bot');
    });
    it('activates and resolves the active embedding profile for a knowledge space', async () => {
        const profileRow = {
            bot_id: 'bot-1',
            created_at: '2026-04-24T00:00:00.000Z',
            dimensions: 768,
            distance_metric: 'cosine',
            id: 'profile-2',
            knowledge_space_id: 'space-1',
            model: 'gemini-embedding-2',
            provider: 'google',
            purpose_defaults: ['retrieval_document', 'retrieval_query'],
            status: 'active',
            task_instruction: 'Embed support content.',
            tenant_id: 'tenant-1',
            updated_at: '2026-04-24T00:00:00.000Z',
        };
        const pool = new MockPgPool((text) => {
            if (text.startsWith('SELECT')) {
                return { rowCount: 1, rows: [profileRow] };
            }
            return { rowCount: 1, rows: [] };
        });
        const store = new PostgresKnowledgeStore({ pool });
        await store.activateEmbeddingProfile({
            botId: 'bot-1',
            embeddingProfileId: 'profile-2',
            knowledgeSpaceId: 'space-1',
            tenantId: 'tenant-1',
        });
        const active = await store.getActiveEmbeddingProfile({
            botId: 'bot-1',
            knowledgeSpaceId: 'space-1',
            tenantId: 'tenant-1',
        });
        const updateQuery = pool.queries.find((query) => query.text.startsWith('UPDATE'));
        expect(updateQuery?.text).toContain('active_embedding_profile_id');
        expect(active).toMatchObject({
            dimensions: 768,
            id: 'profile-2',
            knowledgeSpaceId: 'space-1',
            model: 'gemini-embedding-2',
            purposeDefaults: ['retrieval_document', 'retrieval_query'],
            taskInstruction: 'Embed support content.',
        });
    });
    it('treats embedding profile shape as immutable', async () => {
        const pool = new MockPgPool((text) => {
            if (text.startsWith('SELECT')) {
                return {
                    rowCount: 1,
                    rows: [
                        {
                            bot_id: 'bot-1',
                            created_at: '2026-04-24T00:00:00.000Z',
                            dimensions: 768,
                            distance_metric: 'cosine',
                            id: 'profile-immutable',
                            knowledge_space_id: 'space-1',
                            model: 'gemini-embedding-2',
                            provider: 'google',
                            purpose_defaults: ['retrieval_document'],
                            status: 'active',
                            task_instruction: null,
                            tenant_id: 'tenant-1',
                            updated_at: '2026-04-24T00:00:00.000Z',
                        },
                    ],
                };
            }
            return { rowCount: 0, rows: [] };
        });
        const store = new PostgresKnowledgeStore({ pool });
        await expect(store.upsertEmbeddingProfile({
            botId: 'bot-1',
            dimensions: 1536,
            id: 'profile-immutable',
            knowledgeSpaceId: 'space-1',
            model: 'gemini-embedding-2',
            provider: 'google',
            purposeDefaults: ['retrieval_document'],
            tenantId: 'tenant-1',
        })).rejects.toBeInstanceOf(LLMError);
    });
    it('requires strict filters for Postgres retrieval', async () => {
        const pool = new MockPgPool();
        const store = new PostgresKnowledgeStore({ pool });
        await expect(store.searchByEmbedding({
            limit: 5,
            queryEmbedding: [0.1, 0.2],
        })).rejects.toBeInstanceOf(LLMError);
        await expect(store.searchByText({
            limit: 5,
            query: 'refund policy',
        })).rejects.toBeInstanceOf(LLMError);
        await expect(store.searchByEmbedding({
            filter: {
                botId: 'bot-1',
                embeddingProfileId: 'profile-1',
                knowledgeSpaceId: 'space-1',
                tenantId: 'tenant-1',
            },
            limit: 5,
            queryEmbedding: [],
        })).rejects.toBeInstanceOf(LLMError);
        await expect(store.searchByEmbedding({
            filter: {
                botId: 'bot-1',
                embeddingProfileId: 'profile-1',
                knowledgeSpaceId: 'space-1',
                tenantId: 'tenant-1',
            },
            limit: 5,
            queryEmbedding: [Number.NaN],
        })).rejects.toBeInstanceOf(LLMError);
    });
    it('creates an internal pg pool from connectionString when no pool is supplied', async () => {
        const mockPool = new MockPgPool();
        pgMockState.poolConstructor.mockImplementation(() => mockPool);
        const store = new PostgresKnowledgeStore({
            connectionString: 'postgres://example.test/app',
        });
        await store.ensureSchema();
        expect(pgMockState.poolConstructor).toHaveBeenCalledWith({
            connectionString: 'postgres://example.test/app',
        });
        expect(mockPool.queries.length).toBeGreaterThan(0);
    });
    it('preserves explicit citations when storing chunks', async () => {
        const pool = new MockPgPool();
        const store = new PostgresKnowledgeStore({ pool });
        await store.upsertKnowledgeChunk({
            botId: 'bot-1',
            chunkIndex: 1,
            citation: {
                chunkId: 'chunk-2',
                endOffset: 12,
                metadata: { section: 'billing' },
                ordinal: 2,
                sourceId: 'source-2',
                sourceName: 'Billing Manual',
                startOffset: 3,
                title: 'Billing Rules',
                url: 'https://example.test/billing',
            },
            embedding: [0.9, 0.8],
            embeddingProfileId: 'profile-1',
            id: 'chunk-2',
            knowledgeSpaceId: 'space-1',
            sourceId: 'source-2',
            tenantId: 'tenant-1',
            text: 'Manual review is required.',
        });
        const serializedCitation = JSON.parse(String(pool.queries.at(-1)?.values?.[8]));
        expect(serializedCitation).toEqual({
            chunkId: 'chunk-2',
            endOffset: 12,
            metadata: { section: 'billing' },
            ordinal: 2,
            sourceId: 'source-2',
            sourceName: 'Billing Manual',
            startOffset: 3,
            title: 'Billing Rules',
            url: 'https://example.test/billing',
        });
    });
    it('runs dense retrieval with strict filters and maps results', async () => {
        const row = {
            chunk_id: 'chunk-1',
            chunk_text: 'Refunds are available for 30 days.',
            citation: {
                chunkId: 'chunk-1',
                sourceId: 'source-1',
                title: 'Refund Policy',
            },
            end_offset: 35,
            metadata: { locale: 'en' },
            score: '0.9123',
            source_id: 'source-1',
            source_name: 'Billing FAQ',
            start_offset: 0,
            title: 'Refund Policy',
            url: 'https://example.test/refunds',
        };
        const pool = new MockPgPool((text) => {
            if (text.startsWith('SELECT')) {
                return { rowCount: 1, rows: [row] };
            }
            return { rowCount: 0, rows: [] };
        });
        const store = new PostgresKnowledgeStore({ pool });
        const results = await store.searchByEmbedding({
            filter: {
                botId: 'bot-1',
                embeddingProfileId: 'profile-1',
                knowledgeSpaceId: 'space-1',
                locale: 'en',
                metadata: { product: 'billing' },
                scopeType: 'user',
                scopeUserId: 'user-1',
                sourceIds: ['source-1'],
                sourceTypes: ['pdf'],
                tenantId: 'tenant-1',
            },
            limit: 4,
            minScore: 0.5,
            queryEmbedding: [0.12, 0.34, 0.56],
        });
        const selectQuery = pool.queries.find((query) => query.text.startsWith('SELECT'));
        expect(selectQuery?.text).toContain("s.status = 'ready'");
        expect(selectQuery?.text).toContain('c.embedding_profile_id =');
        expect(selectQuery?.text).toContain("COALESCE(c.metadata ->> 'locale'");
        expect(selectQuery?.text).toContain('c.metadata @>');
        expect(selectQuery?.text).toContain('c.scope_type =');
        expect(selectQuery?.text).toContain('c.scope_user_id =');
        expect(selectQuery?.text).toContain('c.source_id = ANY');
        expect(selectQuery?.text).toContain('source_type');
        expect(selectQuery?.values).toContain('[0.12,0.34,0.56]');
        expect(results).toEqual([
            {
                chunkId: 'chunk-1',
                citation: {
                    chunkId: 'chunk-1',
                    sourceId: 'source-1',
                    sourceName: 'Billing FAQ',
                    title: 'Refund Policy',
                    url: 'https://example.test/refunds',
                },
                denseScore: 0.9123,
                endOffset: 35,
                metadata: { locale: 'en' },
                raw: row,
                score: 0.9123,
                sourceId: 'source-1',
                sourceName: 'Billing FAQ',
                startOffset: 0,
                text: 'Refunds are available for 30 days.',
                title: 'Refund Policy',
                url: 'https://example.test/refunds',
            },
        ]);
    });
    it('runs lexical retrieval and returns an empty result for blank queries', async () => {
        const row = {
            chunk_id: 'chunk-2',
            chunk_text: 'Processing fees are non-refundable.',
            citation: null,
            end_offset: null,
            metadata: null,
            score: 0.77,
            source_id: 'source-2',
            source_name: 'Fees FAQ',
            start_offset: null,
            title: null,
            url: null,
        };
        const pool = new MockPgPool((text) => {
            if (text.startsWith('SELECT')) {
                return { rowCount: 1, rows: [row] };
            }
            return { rowCount: 0, rows: [] };
        });
        const store = new PostgresKnowledgeStore({ pool });
        expect(await store.searchByText({
            filter: {
                botId: 'bot-1',
                embeddingProfileId: 'profile-1',
                knowledgeSpaceId: 'space-1',
                tenantId: 'tenant-1',
            },
            limit: 3,
            query: '   ',
        })).toEqual([]);
        const results = await store.searchByText({
            filter: {
                botId: 'bot-1',
                embeddingProfileId: 'profile-1',
                knowledgeSpaceId: 'space-1',
                tenantId: 'tenant-1',
            },
            limit: 3,
            query: 'processing fees',
        });
        expect(results[0]).toMatchObject({
            chunkId: 'chunk-2',
            citation: {
                chunkId: 'chunk-2',
                sourceId: 'source-2',
                sourceName: 'Fees FAQ',
            },
            lexicalScore: 0.77,
            score: 0.77,
            sourceId: 'source-2',
            sourceName: 'Fees FAQ',
            text: 'Processing fees are non-refundable.',
        });
    });
    it('lists knowledge sources and can mark them as needing reindex', async () => {
        const pool = new MockPgPool((text) => {
            if (text.startsWith('SELECT')) {
                return {
                    rowCount: 1,
                    rows: [
                        {
                            bot_id: 'bot-1',
                            canonical_url: 'https://example.test/refunds.pdf',
                            checksum: 'abc123',
                            created_at: '2026-04-24T00:00:00.000Z',
                            embedding_profile_id: 'profile-1',
                            error_message: null,
                            external_id: 'ext-1',
                            id: 'source-1',
                            knowledge_space_id: 'space-1',
                            metadata: { locale: 'en' },
                            name: 'Refund Policy PDF',
                            progress_percent: 100,
                            source_type: 'pdf',
                            status: 'ready',
                            tenant_id: 'tenant-1',
                            title: 'Refund Policy',
                            updated_at: '2026-04-24T00:00:00.000Z',
                        },
                    ],
                };
            }
            return { rowCount: 2, rows: [] };
        });
        const store = new PostgresKnowledgeStore({ pool });
        const sources = await store.listKnowledgeSources({
            botId: 'bot-1',
            embeddingProfileId: 'profile-1',
            knowledgeSpaceId: 'space-1',
            statuses: ['ready'],
            tenantId: 'tenant-1',
        });
        const updated = await store.markKnowledgeSourcesNeedingReindex({
            botId: 'bot-1',
            fromEmbeddingProfileId: 'profile-1',
            knowledgeSpaceId: 'space-1',
            tenantId: 'tenant-1',
            toEmbeddingProfileId: 'profile-2',
        });
        const selectQuery = pool.queries.find((query) => query.text.startsWith('SELECT') && query.text.includes('FROM "public"."knowledge_sources"'));
        const updateQuery = pool.queries.find((query) => query.text.startsWith('UPDATE') && query.text.includes('"public"."knowledge_sources"'));
        expect(selectQuery?.text).toContain('status = ANY');
        expect(updateQuery?.text).toContain("status = 'needs_reindex'");
        expect(sources[0]).toMatchObject({
            checksum: 'abc123',
            embeddingProfileId: 'profile-1',
            sourceType: 'pdf',
            status: 'ready',
        });
        expect(updated).toBe(2);
    });
    it('maps explicit stored citations from Postgres rows', async () => {
        const row = {
            chunk_id: 'chunk-3',
            chunk_text: 'Late fees cannot be waived automatically.',
            citation: {
                chunkId: 'chunk-3',
                endOffset: 18,
                metadata: { policy: 'fees' },
                ordinal: 3,
                sourceId: 'source-3',
                sourceName: 'Explicit Source',
                startOffset: 4,
                title: 'Explicit Title',
                url: 'https://example.test/fees',
            },
            end_offset: null,
            metadata: null,
            score: 0.66,
            source_id: 'source-3',
            source_name: 'Ignored Source',
            start_offset: null,
            title: null,
            url: null,
        };
        const pool = new MockPgPool((text) => {
            if (text.startsWith('SELECT')) {
                return { rowCount: 1, rows: [row] };
            }
            return { rowCount: 0, rows: [] };
        });
        const store = new PostgresKnowledgeStore({ pool });
        const results = await store.searchByText({
            filter: {
                botId: 'bot-1',
                embeddingProfileId: 'profile-1',
                knowledgeSpaceId: 'space-1',
                tenantId: 'tenant-1',
            },
            limit: 3,
            query: 'late fees',
        });
        expect(results[0]?.citation).toEqual({
            chunkId: 'chunk-3',
            endOffset: 18,
            metadata: { policy: 'fees' },
            ordinal: 3,
            sourceId: 'source-3',
            sourceName: 'Explicit Source',
            startOffset: 4,
            title: 'Explicit Title',
            url: 'https://example.test/fees',
        });
    });
    it('falls back to row titles when stored citations omit them', async () => {
        const row = {
            chunk_id: 'chunk-4',
            chunk_text: 'Refund exceptions require manual approval.',
            citation: {
                chunkId: 'chunk-4',
                sourceId: 'source-4',
            },
            end_offset: null,
            metadata: null,
            score: 0.55,
            source_id: 'source-4',
            source_name: 'Approvals FAQ',
            start_offset: null,
            title: 'Manual Approval',
            url: 'https://example.test/approvals',
        };
        const pool = new MockPgPool((text) => {
            if (text.startsWith('SELECT')) {
                return { rowCount: 1, rows: [row] };
            }
            return { rowCount: 0, rows: [] };
        });
        const store = new PostgresKnowledgeStore({ pool });
        const results = await store.searchByText({
            filter: {
                botId: 'bot-1',
                embeddingProfileId: 'profile-1',
                knowledgeSpaceId: 'space-1',
                tenantId: 'tenant-1',
            },
            limit: 2,
            query: 'manual approval',
        });
        expect(results[0]?.citation).toEqual({
            chunkId: 'chunk-4',
            sourceId: 'source-4',
            sourceName: 'Approvals FAQ',
            title: 'Manual Approval',
            url: 'https://example.test/approvals',
        });
    });
    it('builds a per-profile HNSW index statement for pgvector', () => {
        const sql = createPgvectorHnswIndexSql({
            dimensions: 768,
            distanceMetric: 'cosine',
            embeddingProfileId: 'profile-2026-04-24',
        });
        expect(sql).toContain('USING hnsw');
        expect(sql).toContain('vector_cosine_ops');
        expect(sql).toContain('embedding_profile_id = \'profile-2026-04-24\'');
        expect(sql).toContain('embedding::vector(768)');
    });
    it('supports l2 operator classes for pgvector indexes', () => {
        const sql = createPgvectorHnswIndexSql({
            dimensions: 384,
            distanceMetric: 'l2',
            embeddingProfileId: 'profile-l2',
        });
        expect(sql).toContain('vector_l2_ops');
        expect(sql).toContain('embedding::vector(384)');
    });
    it('supports inner-product operator classes for pgvector indexes', () => {
        const sql = createPgvectorHnswIndexSql({
            dimensions: 256,
            distanceMetric: 'inner_product',
            embeddingProfileId: 'profile-ip',
        });
        expect(sql).toContain('vector_ip_ops');
        expect(sql).toContain('embedding::vector(256)');
    });
});
