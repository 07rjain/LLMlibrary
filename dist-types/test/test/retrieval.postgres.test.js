import { describe, expect, it } from 'vitest';
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
    it('bootstraps the pgvector schema and indexes', async () => {
        const pool = new MockPgPool();
        const store = new PostgresKnowledgeStore({ pool });
        await store.ensureSchema();
        expect(pool.queries[0]?.text).toContain('CREATE EXTENSION IF NOT EXISTS vector');
        expect(pool.queries.some((query) => query.text.includes('"public"."knowledge_spaces"'))).toBe(true);
        expect(pool.queries.some((query) => query.text.includes('"public"."knowledge_chunks"'))).toBe(true);
        expect(pool.queries.some((query) => query.text.includes('"knowledge_chunks_search_document_idx"'))).toBe(true);
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
});
