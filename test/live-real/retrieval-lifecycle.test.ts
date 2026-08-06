import { describe, expect, it } from 'vitest';

import { loadPgPoolConstructor } from '../../src/node-pg-loader.js';
import {
  createHybridRetriever,
  createPostgresKnowledgeStore,
} from '../../src/retrieval.js';
import type {
  PostgresEmbeddingProfileRecord,
  PostgresKnowledgeChunkRecord,
  PostgresKnowledgeSourceRecord,
  PostgresKnowledgeSpaceRecord,
  RetrievalFilter,
} from '../../src/retrieval.js';
import type { EmbeddingResponse } from '../../src/types.js';
import { liveRealEnabled, requireLiveEnv } from './helpers.js';

const liveDescribe = liveRealEnabled ? describe : describe.skip;
const dimensions = 8;

const fixedVector = (index: number): number[] =>
  Array.from({ length: dimensions }, (_value, position) =>
    position === index ? 1 : 0,
  );

function strictFilter(
  tenantId: string,
  botId: string,
  knowledgeSpaceId: string,
  embeddingProfileId: string,
): RetrievalFilter {
  return { botId, embeddingProfileId, knowledgeSpaceId, tenantId };
}

function fixedEmbedResponse(values: number[]): EmbeddingResponse {
  return {
    embeddings: [{ index: 0, values }],
    model: 'fixed-8d-test',
    provider: 'mock',
    raw: null,
  };
}

liveDescribe('live-real Postgres retrieval lifecycle', () => {
  it('isolates scopes and covers deterministic retrieval lifecycle operations', async () => {
    requireLiveEnv('DATABASE_URL');
    const Pool = await loadPgPoolConstructor();
    if (!Pool) throw new Error('The pg Pool constructor is unavailable.');

    const schemaName = `rag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (!/^rag_[a-z0-9_]+$/.test(schemaName)) {
      throw new Error(
        'Generated Postgres schema name failed safety validation.',
      );
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const store = createPostgresKnowledgeStore({ pool, schemaName });
    try {
      await store.ensureSchema();

      const tenantA = `${schemaName}_tenant_a`;
      const tenantB = `${schemaName}_tenant_b`;
      const botA = `${schemaName}_bot_a`;
      const botB = `${schemaName}_bot_b`;
      const spaceA = `${schemaName}_space_a`;
      const spaceB = `${schemaName}_space_b`;
      const profileA = `${schemaName}_profile_a`;
      const profileB = `${schemaName}_profile_b`;
      const sourceA = `${schemaName}_source_a`;
      const sourceB = `${schemaName}_source_b`;
      const chunkA = `${schemaName}_chunk_a`;
      const chunkB = `${schemaName}_chunk_b`;

      const spaceRecord = (
        id: string,
        tenantId: string,
        botId: string,
      ): PostgresKnowledgeSpaceRecord => ({
        botId,
        id,
        name: `${id} space`,
        tenantId,
      });
      const profileRecord = (
        id: string,
        tenantId: string,
        botId: string,
        knowledgeSpaceId: string,
      ): PostgresEmbeddingProfileRecord => ({
        botId,
        dimensions,
        id,
        knowledgeSpaceId,
        model: 'fixed-8d-test',
        provider: 'mock',
        tenantId,
      });
      const sourceRecord = (
        id: string,
        tenantId: string,
        botId: string,
        knowledgeSpaceId: string,
        embeddingProfileId: string,
        name: string,
      ): PostgresKnowledgeSourceRecord => ({
        botId,
        embeddingProfileId,
        id,
        knowledgeSpaceId,
        metadata: { scope: name },
        name,
        sourceType: 'test',
        status: 'ready',
        tenantId,
        title: `${name} title`,
      });
      const chunkRecord = (
        id: string,
        tenantId: string,
        botId: string,
        knowledgeSpaceId: string,
        sourceId: string,
        embeddingProfileId: string,
        text: string,
        vectorIndex: number,
      ): PostgresKnowledgeChunkRecord => ({
        botId,
        chunkIndex: 0,
        embedding: fixedVector(vectorIndex),
        embeddingProfileId,
        id,
        knowledgeSpaceId,
        metadata: { scope: id.endsWith('_a') ? 'a' : 'b' },
        sourceId,
        sourceName: `${sourceId} source`,
        tenantId,
        text,
        title: `${sourceId} title`,
      });

      await store.upsertKnowledgeSpace(spaceRecord(spaceA, tenantA, botA));
      await store.upsertKnowledgeSpace(spaceRecord(spaceB, tenantB, botB));
      await store.upsertEmbeddingProfile(
        profileRecord(profileA, tenantA, botA, spaceA),
      );
      await store.upsertEmbeddingProfile(
        profileRecord(profileB, tenantB, botB, spaceB),
      );
      await store.activateEmbeddingProfile({
        botId: botA,
        embeddingProfileId: profileA,
        knowledgeSpaceId: spaceA,
        tenantId: tenantA,
      });
      await store.activateEmbeddingProfile({
        botId: botB,
        embeddingProfileId: profileB,
        knowledgeSpaceId: spaceB,
        tenantId: tenantB,
      });

      const sourceARecord = sourceRecord(
        sourceA,
        tenantA,
        botA,
        spaceA,
        profileA,
        'alpha',
      );
      const sourceBRecord = sourceRecord(
        sourceB,
        tenantB,
        botB,
        spaceB,
        profileB,
        'bravo',
      );
      await store.upsertKnowledgeSource(sourceARecord);
      await store.upsertKnowledgeSource(sourceBRecord);
      await store.upsertKnowledgeChunk(
        chunkRecord(
          chunkA,
          tenantA,
          botA,
          spaceA,
          sourceA,
          profileA,
          'alpha scope retrieval marker',
          0,
        ),
      );
      await store.upsertKnowledgeChunk(
        chunkRecord(
          chunkB,
          tenantB,
          botB,
          spaceB,
          sourceB,
          profileB,
          'bravo scope retrieval marker',
          1,
        ),
      );

      const filterA = strictFilter(tenantA, botA, spaceA, profileA);
      const filterB = strictFilter(tenantB, botB, spaceB, profileB);
      const denseA = await store.searchByEmbedding({
        filter: filterA,
        limit: 5,
        queryEmbedding: fixedVector(0),
      });
      const lexicalA = await store.searchByText({
        filter: filterA,
        limit: 5,
        query: 'alpha',
      });
      expect(denseA.map((result) => result.chunkId)).toEqual([chunkA]);
      expect(denseA[0]?.score).toBeGreaterThan(0);
      expect(lexicalA.map((result) => result.chunkId)).toEqual([chunkA]);
      const denseB = await store.searchByEmbedding({
        filter: filterB,
        limit: 5,
        queryEmbedding: fixedVector(1),
      });
      const lexicalB = await store.searchByText({
        filter: filterB,
        limit: 5,
        query: 'bravo',
      });
      expect(denseB.map((result) => result.chunkId)).toEqual([chunkB]);
      expect(lexicalB.map((result) => result.chunkId)).toEqual([chunkB]);

      for (const field of [
        'tenantId',
        'botId',
        'knowledgeSpaceId',
        'embeddingProfileId',
      ] as const) {
        const incomplete = { ...filterA } as Partial<typeof filterA>;
        delete incomplete[field];
        await expect(
          store.searchByEmbedding({
            filter: incomplete,
            limit: 1,
            queryEmbedding: fixedVector(0),
          }),
        ).rejects.toThrow(/strict retrieval filters/);
        await expect(
          store.searchByText({ filter: incomplete, limit: 1, query: 'alpha' }),
        ).rejects.toThrow(/strict retrieval filters/);
      }
      await expect(
        store.searchByEmbedding({
          filter: { ...filterA, tenantId: tenantB },
          limit: 5,
          queryEmbedding: fixedVector(0),
        }),
      ).resolves.toEqual([]);
      await expect(
        store.searchByEmbedding({
          filter: { ...filterA, botId: botB },
          limit: 5,
          queryEmbedding: fixedVector(0),
        }),
      ).resolves.toEqual([]);
      await expect(
        store.searchByText({
          filter: { ...filterA, knowledgeSpaceId: spaceB },
          limit: 5,
          query: 'alpha',
        }),
      ).resolves.toEqual([]);
      await expect(
        store.searchByText({
          filter: { ...filterA, embeddingProfileId: profileB },
          limit: 5,
          query: 'alpha',
        }),
      ).resolves.toEqual([]);

      expect(
        (
          await store.listKnowledgeSources({
            botId: botA,
            knowledgeSpaceId: spaceA,
            limit: 10,
            tenantId: tenantA,
          })
        ).map((source) => source.id),
      ).toEqual([sourceA]);
      await expect(
        store.listKnowledgeSources({
          botId: botB,
          knowledgeSpaceId: spaceA,
          limit: 10,
          tenantId: tenantB,
        }),
      ).resolves.toEqual([]);

      for (const change of [
        { model: 'changed-model' },
        { provider: 'google' as const },
        { dimensions: dimensions + 1 },
      ]) {
        await expect(
          store.upsertEmbeddingProfile({
            ...profileRecord(profileA, tenantA, botA, spaceA),
            ...change,
          }),
        ).rejects.toThrow(/immutable/i);
      }
      expect(
        (
          await store.upsertEmbeddingProfile({
            ...profileRecord(profileA, tenantA, botA, spaceA),
            status: 'inactive',
          })
        ).status,
      ).toBe('inactive');
      await expect(
        store.activateEmbeddingProfile({
          botId: botA,
          embeddingProfileId: profileB,
          knowledgeSpaceId: spaceA,
          tenantId: tenantA,
        }),
      ).rejects.toThrow(/does not belong|cannot activate/i);
      expect(
        (
          await store.getActiveEmbeddingProfile({
            botId: botA,
            knowledgeSpaceId: spaceA,
            tenantId: tenantA,
          })
        )?.id,
      ).toBe(profileA);

      const profileA2 = `${schemaName}_profile_a2`;
      await store.upsertEmbeddingProfile(
        profileRecord(profileA2, tenantA, botA, spaceA),
      );
      await store.activateEmbeddingProfile({
        botId: botA,
        embeddingProfileId: profileA2,
        knowledgeSpaceId: spaceA,
        tenantId: tenantA,
      });
      expect(
        (
          await store.getActiveEmbeddingProfile({
            botId: botA,
            knowledgeSpaceId: spaceA,
            tenantId: tenantA,
          })
        )?.id,
      ).toBe(profileA2);
      expect(
        await store.markKnowledgeSourcesNeedingReindex({
          botId: botA,
          fromEmbeddingProfileId: profileA,
          knowledgeSpaceId: spaceA,
          tenantId: tenantA,
          toEmbeddingProfileId: profileA2,
        }),
      ).toBe(1);
      expect(
        (
          await store.listKnowledgeSources({
            botId: botA,
            knowledgeSpaceId: spaceA,
            limit: 10,
            statuses: ['needs_reindex'],
            tenantId: tenantA,
          })
        ).map((source) => source.id),
      ).toEqual([sourceA]);

      await store.upsertKnowledgeSource({
        ...sourceARecord,
        embeddingProfileId: profileA2,
        metadata: { scope: 'alpha-updated' },
        name: 'alpha-updated',
        status: 'ready',
        title: 'alpha updated title',
      });
      await store.upsertKnowledgeChunk(
        chunkRecord(
          chunkA,
          tenantA,
          botA,
          spaceA,
          sourceA,
          profileA2,
          'alpha-updated mutation marker',
          0,
        ),
      );
      const updatedFilterA = strictFilter(tenantA, botA, spaceA, profileA2);
      expect(
        (
          await store.searchByText({
            filter: updatedFilterA,
            limit: 5,
            query: 'mutation',
          })
        )[0]?.text,
      ).toContain('mutation marker');
      await expect(
        store.upsertKnowledgeSource({
          ...sourceARecord,
          botId: botB,
          tenantId: tenantB,
        }),
      ).rejects.toThrow(/ownership|tenant|bot/i);

      const hybrid = createHybridRetriever({
        defaultDenseK: 2,
        defaultLexicalK: 2,
        embed: async () => fixedEmbedResponse(fixedVector(0)),
        embedding: { dimensions, model: 'fixed-8d-test', provider: 'mock' },
        store,
      });
      const hybridResults = await hybrid.search({
        filter: updatedFilterA,
        query: 'mutation',
        topK: 1,
      });
      expect(hybridResults[0]?.chunkId).toBe(chunkA);
      expect(hybridResults[0]?.denseScore).toBeDefined();
      expect(hybridResults[0]?.lexicalScore).toBeDefined();
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, 120_000);
});
