import { afterAll, describe, expect, it } from 'vitest';

import { LLMClient } from '../../src/client.js';
import {
  createDenseRetriever,
  createPostgresKnowledgeStore,
} from '../../src/retrieval.js';

const liveEnabled = process.env.LIVE_TESTS === '1';
const pdfLiveEnabled = process.env.GEMINI_EMBEDDING_PDF_LIVE === '1';
const liveDescribe = liveEnabled ? describe : describe.skip;

function liveIt(enabled: boolean) {
  return enabled ? it : it.skip;
}

liveDescribe('live embeddings smoke', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const action of cleanup.reverse()) {
      await action();
    }
  });

  liveIt(Boolean(process.env.GEMINI_API_KEY))(
    'embeds a text query with Gemini',
    async () => {
      const client = LLMClient.fromEnv({
        defaultEmbeddingModel: 'gemini-embedding-2',
      });

      const response = await client.embed({
        dimensions: 768,
        input: 'Refunds are available for 30 days after purchase.',
        purpose: 'retrieval_document',
        providerOptions: {
          google: {
            title: 'Refund Policy',
          },
        },
      });

      expect(response.provider).toBe('google');
      expect(response.embeddings[0]?.values.length).toBe(768);
      expect(response.usage?.inputTokens).toBeGreaterThan(0);
    },
    20_000,
  );

  liveIt(Boolean(process.env.GEMINI_API_KEY) && Boolean(process.env.DATABASE_URL))(
    'stores an embedding in Postgres and retrieves it back through the dense retriever',
    async () => {
      const client = LLMClient.fromEnv({
        defaultEmbeddingModel: 'gemini-embedding-2',
      });
      const schemaName = `live_embeddings_${Date.now()}`;
      const store = createPostgresKnowledgeStore({ schemaName });
      cleanup.push(async () => {
        await store.close();
      });

      await store.ensureSchema();

      const knowledgeSpaceId = `space_${Date.now()}`;
      const embeddingProfileId = `profile_${Date.now()}`;
      const sourceId = `source_${Date.now()}`;
      const chunkId = `chunk_${Date.now()}`;
      const tenantId = 'live-tenant';
      const botId = 'live-bot';

      await store.upsertKnowledgeSpace({
        botId,
        id: knowledgeSpaceId,
        name: 'Live Support KB',
        tenantId,
      });
      await store.upsertEmbeddingProfile({
        botId,
        dimensions: 768,
        id: embeddingProfileId,
        knowledgeSpaceId,
        model: 'gemini-embedding-2',
        provider: 'google',
        purposeDefaults: ['retrieval_document', 'retrieval_query'],
        tenantId,
      });
      await store.activateEmbeddingProfile({
        botId,
        embeddingProfileId,
        knowledgeSpaceId,
        tenantId,
      });

      const documentEmbedding = await client.embed({
        dimensions: 768,
        input: 'Refunds are available for 30 days after purchase.',
        model: 'gemini-embedding-2',
        provider: 'google',
        purpose: 'retrieval_document',
        providerOptions: {
          google: {
            title: 'Refund Policy',
          },
        },
      });

      await store.upsertKnowledgeSource({
        botId,
        embeddingProfileId,
        id: sourceId,
        knowledgeSpaceId,
        name: 'Refund Policy',
        sourceType: 'faq',
        status: 'ready',
        tenantId,
        title: 'Refund Policy',
      });
      await store.upsertKnowledgeChunk({
        botId,
        chunkIndex: 0,
        embedding: documentEmbedding.embeddings[0]!.values,
        embeddingProfileId,
        id: chunkId,
        knowledgeSpaceId,
        sourceId,
        sourceName: 'Refund Policy',
        tenantId,
        text: 'Refunds are available for 30 days after purchase.',
        title: 'Refund Policy',
      });

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
        filter: {
          botId,
          embeddingProfileId,
          knowledgeSpaceId,
          tenantId,
        },
        query: 'How long do refunds last?',
        topK: 1,
      });

      expect(results[0]?.chunkId).toBe(chunkId);
      expect(results[0]?.score).toBeGreaterThan(0);
    },
    45_000,
  );

  liveIt(Boolean(process.env.GEMINI_API_KEY) && pdfLiveEnabled)(
    'embeds a tiny PDF document when the dedicated PDF gate is enabled',
    async () => {
      const client = LLMClient.fromEnv({
        defaultEmbeddingModel: 'gemini-embedding-2',
      });

      const response = await client.embed({
        dimensions: 768,
        input: [
          {
            data: createMinimalPdfBase64(),
            mediaType: 'application/pdf',
            type: 'document',
          },
        ],
        purpose: 'retrieval_document',
        providerOptions: {
          google: {
            title: 'Tiny PDF',
          },
        },
      });

      expect(response.provider).toBe('google');
      expect(response.embeddings[0]?.values.length).toBe(768);
    },
    30_000,
  );
});

function createMinimalPdfBase64(): string {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 1 /Kids [3 0 R] >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 12 Tf 20 100 Td (Refund policy page one) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000063 00000 n 
0000000122 00000 n 
0000000248 00000 n 
0000000342 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
startxref
412
%%EOF`;

  return Buffer.from(pdf, 'utf8').toString('base64');
}
