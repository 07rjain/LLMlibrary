import { describe, expect, it, vi } from 'vitest';

import { LLMError } from '../src/errors.js';
import {
  createDenseRetriever,
  createHybridRetriever,
  formatRetrievedContext,
  mergeRetrievalCandidates,
} from '../src/retrieval.js';

import type {
  DenseKnowledgeSearchOptions,
  KnowledgeStore,
  LexicalKnowledgeSearchOptions,
  RetrievalResult,
} from '../src/retrieval.js';
import type { EmbeddingRequestOptions, EmbeddingResponse } from '../src/types.js';

describe('retrieval helpers', () => {
  it('creates a dense retriever around embed() and the knowledge store', async () => {
    const embed = vi.fn<(options: EmbeddingRequestOptions) => Promise<EmbeddingResponse>>(
      async () => ({
        embeddings: [{ index: 0, values: [0.12, 0.34, 0.56] }],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
    );
    const searchByEmbedding = vi.fn<
      (options: DenseKnowledgeSearchOptions) => Promise<RetrievalResult[]>
    >(async () => [
      {
        chunkId: 'chunk-1',
        score: 0.93,
        sourceId: 'source-a',
        sourceName: 'FAQ',
        text: 'Refunds are available for 30 days.',
        title: 'Refund Policy',
      },
    ]);
    const store: KnowledgeStore = {
      searchByEmbedding,
    };
    const retriever = createDenseRetriever({
      defaultTopK: 6,
      embed,
      embedding: {
        dimensions: 768,
        model: 'gemini-embedding-2',
      },
      store,
    });

    const results = await retriever.search({
      filter: {
        botId: 'bot-1',
        tenantId: 'tenant-1',
      },
      query: 'What is your refund policy?',
    });

    expect(embed).toHaveBeenCalledWith({
      botId: 'bot-1',
      dimensions: 768,
      input: 'What is your refund policy?',
      model: 'gemini-embedding-2',
      provider: undefined,
      providerOptions: undefined,
      purpose: 'retrieval_query',
      tenantId: 'tenant-1',
    });
    expect(searchByEmbedding).toHaveBeenCalledWith({
      filter: {
        botId: 'bot-1',
        tenantId: 'tenant-1',
      },
      limit: 6,
      minScore: undefined,
      queryEmbedding: [0.12, 0.34, 0.56],
    });
    expect(results).toEqual([
      {
        chunkId: 'chunk-1',
        score: 0.93,
        sourceId: 'source-a',
        sourceName: 'FAQ',
        text: 'Refunds are available for 30 days.',
        title: 'Refund Policy',
      },
    ]);
  });

  it('supports embed invokers and forwards embedding options', async () => {
    const embed = vi.fn<(options: EmbeddingRequestOptions) => Promise<EmbeddingResponse>>(
      async () => ({
        embeddings: [{ index: 0, values: [0.4, 0.8] }],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
    );
    const retriever = createDenseRetriever({
      embed: { embed },
      embedding: {
        dimensions: 512,
        model: 'gemini-embedding-2',
        provider: 'google',
        providerOptions: {
          google: {
            taskInstruction: 'Classify billing support content.',
            title: 'Ignored at query time',
          },
        },
        purpose: 'classification',
      },
      store: {
        searchByEmbedding: async () => [],
      },
    });

    await retriever.search({
      filter: {
        botId: 'bot-2',
        tenantId: 'tenant-2',
      },
      input: 'Classify this support request.',
      query: 'fallback query text',
    });

    expect(embed).toHaveBeenCalledWith({
      botId: 'bot-2',
      dimensions: 512,
      input: 'Classify this support request.',
      model: 'gemini-embedding-2',
      provider: 'google',
      providerOptions: {
        google: {
          taskInstruction: 'Classify billing support content.',
          title: 'Ignored at query time',
        },
      },
      purpose: 'classification',
      tenantId: 'tenant-2',
    });
  });

  it('merges dense and lexical candidates for hybrid retrieval', async () => {
    const embed = vi.fn<(options: EmbeddingRequestOptions) => Promise<EmbeddingResponse>>(
      async () => ({
        embeddings: [{ index: 0, values: [0.7, 0.2] }],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
    );
    const searchByEmbedding = vi.fn<
      (options: DenseKnowledgeSearchOptions) => Promise<RetrievalResult[]>
    >(async () => [
      {
        chunkId: 'chunk-a',
        score: 0.91,
        sourceId: 'source-1',
        text: 'Refunds are available for 30 days.',
      },
      {
        chunkId: 'chunk-b',
        score: 0.87,
        sourceId: 'source-2',
        text: 'Support can approve an exception.',
      },
    ]);
    const searchByText = vi.fn<
      (options: LexicalKnowledgeSearchOptions) => Promise<RetrievalResult[]>
    >(async () => [
      {
        chunkId: 'chunk-b',
        score: 12,
        sourceId: 'source-2',
        text: 'Support can approve an exception.',
      },
      {
        chunkId: 'chunk-c',
        score: 10,
        sourceId: 'source-3',
        text: 'Processing fees are non-refundable.',
      },
    ]);
    const store: KnowledgeStore = {
      searchByEmbedding,
      searchByText,
    };
    const retriever = createHybridRetriever({
      defaultDenseK: 5,
      defaultLexicalK: 5,
      embed,
      store,
    });

    const results = await retriever.search({
      query: 'refund exception',
      topK: 3,
    });

    expect(searchByEmbedding).toHaveBeenCalledWith({
      filter: undefined,
      limit: 5,
      minScore: undefined,
      queryEmbedding: [0.7, 0.2],
    });
    expect(searchByText).toHaveBeenCalledWith({
      filter: undefined,
      limit: 5,
      minScore: undefined,
      query: 'refund exception',
    });
    expect(results).toMatchObject([
      {
        chunkId: 'chunk-b',
        denseScore: 0.87,
        lexicalScore: 12,
        sourceId: 'source-2',
      },
      {
        chunkId: 'chunk-a',
        denseScore: 0.91,
        sourceId: 'source-1',
      },
      {
        chunkId: 'chunk-c',
        lexicalScore: 10,
        sourceId: 'source-3',
      },
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('applies dense rerank hooks before final limiting', async () => {
    const rerank = vi.fn(async (results: RetrievalResult[]) => [...results].reverse());
    const retriever = createDenseRetriever({
      defaultTopK: 2,
      embed: async () => ({
        embeddings: [{ index: 0, values: [0.12, 0.34, 0.56] }],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
      rerank,
      store: {
        searchByEmbedding: async () => [
          {
            chunkId: 'chunk-1',
            score: 0.91,
            sourceId: 'source-1',
            text: 'First result',
          },
          {
            chunkId: 'chunk-2',
            score: 0.82,
            sourceId: 'source-2',
            text: 'Second result',
          },
        ],
      },
    });

    const results = await retriever.search({ query: 'refund policy' });

    expect(rerank).toHaveBeenCalledOnce();
    expect(results.map((result) => result.chunkId)).toEqual(['chunk-2', 'chunk-1']);
  });

  it('applies hybrid rerank hooks after candidate fusion', async () => {
    const rerank = vi.fn(async (results: RetrievalResult[]) => results.slice(0, 1));
    const retriever = createHybridRetriever({
      embed: async () => ({
        embeddings: [{ index: 0, values: [0.4, 0.6] }],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
      rerank,
      store: {
        searchByEmbedding: async () => [
          {
            chunkId: 'chunk-1',
            score: 0.91,
            sourceId: 'source-1',
            text: 'Dense result',
          },
        ],
        searchByText: async () => [
          {
            chunkId: 'chunk-2',
            score: 12,
            sourceId: 'source-2',
            text: 'Lexical result',
          },
        ],
      },
    });

    const results = await retriever.search({ query: 'refund policy', topK: 2 });

    expect(rerank).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
  });

  it('throws when a rerank hook returns a non-array result', async () => {
    const retriever = createDenseRetriever({
      embed: async () => ({
        embeddings: [{ index: 0, values: [0.1, 0.2] }],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
      rerank: async () => 'invalid' as unknown as RetrievalResult[],
      store: {
        searchByEmbedding: async () => [],
      },
    });

    await expect(retriever.search({ query: 'refund policy' })).rejects.toBeInstanceOf(
      LLMError,
    );
  });

  it('throws when hybrid retrieval is requested without lexical support', async () => {
    const retriever = createHybridRetriever({
      embed: async () => ({
        embeddings: [{ index: 0, values: [1, 2, 3] }],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
      store: {
        searchByEmbedding: async () => [],
      },
    });

    await expect(retriever.search({ query: 'hello' })).rejects.toBeInstanceOf(LLMError);
  });

  it('throws when dense retrieval does not receive an embedding vector', async () => {
    const retriever = createDenseRetriever({
      embed: async () => ({
        embeddings: [],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
      store: {
        searchByEmbedding: async () => [],
      },
    });

    await expect(retriever.search({ query: 'hello' })).rejects.toBeInstanceOf(LLMError);
  });

  it('throws when hybrid retrieval does not receive an embedding vector', async () => {
    const retriever = createHybridRetriever({
      embed: async () => ({
        embeddings: [],
        model: 'gemini-embedding-2',
        provider: 'google',
        raw: { ok: true },
      }),
      store: {
        searchByEmbedding: async () => [],
        searchByText: async () => [],
      },
    });

    await expect(retriever.search({ query: 'hello' })).rejects.toBeInstanceOf(LLMError);
  });

  it('formats retrieved context with citations and token limits', () => {
    const formatted = formatRetrievedContext(
      [
        {
          chunkId: 'chunk-1',
          metadata: { section: 'billing' },
          score: 0.9,
          sourceId: 'source-a',
          sourceName: 'Billing FAQ',
          text: 'Refunds are available for 30 days after purchase. Contact support if you need help with an exception or billing dispute.',
          title: 'Refund Policy',
        },
        {
          chunkId: 'chunk-2',
          score: 0.8,
          sourceId: 'source-a',
          sourceName: 'Billing FAQ',
          text: 'This second chunk should be skipped because maxPerSource is 1.',
          title: 'Refund Policy',
        },
      ],
      {
        header: 'Knowledge',
        includeMetadataKeys: ['section'],
        includeScores: true,
        maxPerSource: 1,
        maxTokens: 40,
      },
    );

    expect(formatted.text).toContain('Knowledge');
    expect(formatted.text).toContain('[1] Source: Refund Policy');
    expect(formatted.text).toContain('Metadata: section: billing');
    expect(formatted.text).toContain('[truncated]');
    expect(formatted.citations).toEqual([
      {
        chunkId: 'chunk-1',
        metadata: { section: 'billing' },
        ordinal: 1,
        sourceId: 'source-a',
        sourceName: 'Billing FAQ',
        title: 'Refund Policy',
        url: undefined,
      },
    ]);
    expect(formatted.omittedCount).toBe(0);
    expect(formatted.truncated).toBe(true);
    expect(formatted.usedResults).toHaveLength(1);
  });

  it('formats empty results and hard token exhaustion without crashing', () => {
    const empty = formatRetrievedContext([]);
    const exhausted = formatRetrievedContext(
      [
        {
          chunkId: 'chunk-1',
          score: 0.9,
          sourceId: 'source-a',
          text: 'Refunds are available for 30 days.',
        },
      ],
      {
        header: 'Knowledge',
        maxTokens: 1,
      },
    );

    expect(empty).toEqual({
      citations: [],
      estimatedTokens: 0,
      omittedCount: 0,
      text: '',
      truncated: false,
      usedResults: [],
    });
    expect(exhausted.text).toBe('Knowledge\n\n');
    expect(exhausted.omittedCount).toBe(1);
    expect(exhausted.truncated).toBe(true);
  });

  it('uses the fallback formatter when the full prefix is too large for the token budget', () => {
    const formatted = formatRetrievedContext(
      [
        {
          chunkId: 'chunk-1',
          metadata: { section: 'billing' },
          score: 0.9,
          sourceId: 'source-a',
          sourceName: 'Billing FAQ',
          text: 'Short answer.',
          title: 'Refund Policy',
        },
      ],
      {
        header: 'K',
        includeMetadataKeys: ['section'],
        includeScores: true,
        maxTokens: 15,
      },
    );

    expect(formatted.text).toContain('[1] Source: Refund Policy');
    expect(formatted.text).not.toContain('Score:');
    expect(formatted.text).not.toContain('Metadata:');
    expect(formatted.text).toContain('Short');
    expect(formatted.text).toContain('[truncated]');
    expect(formatted.citations[0]).toMatchObject({
      chunkId: 'chunk-1',
      ordinal: 1,
      sourceId: 'source-a',
    });
  });

  it('keeps short text intact when the truncation budget is still sufficient', () => {
    const formatted = formatRetrievedContext(
      [
        {
          chunkId: 'chunk-1',
          metadata: { section: 'billing' },
          score: 0.9,
          sourceId: 'source-a',
          text: 'OK',
          title: 'Refund Policy',
        },
      ],
      {
        header: 'K',
        includeMetadataKeys: ['section'],
        includeScores: true,
        maxTokens: 15,
      },
    );

    expect(formatted.text).toContain('OK');
    expect(formatted.text).toContain('[truncated]');
  });

  it('merges retrieval candidates directly with reciprocal rank fusion', () => {
    const results = mergeRetrievalCandidates({
      denseResults: [
        {
          chunkId: 'chunk-a',
          score: 0.92,
          sourceId: 'source-1',
          text: 'Dense hit',
        },
      ],
      lexicalResults: [
        {
          chunkId: 'chunk-a',
          score: 11,
          sourceId: 'source-1',
          text: 'Dense hit',
        },
        {
          chunkId: 'chunk-b',
          score: 10,
          sourceId: 'source-2',
          text: 'Lexical only hit',
        },
      ],
      topK: 2,
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      chunkId: 'chunk-a',
      denseScore: 0.92,
      lexicalScore: 11,
      rank: 1,
      sourceId: 'source-1',
    });
    expect(results[1]).toMatchObject({
      chunkId: 'chunk-b',
      lexicalScore: 10,
      rank: 2,
      sourceId: 'source-2',
    });
  });

  it('merges retrieval details and formats array/object metadata', () => {
    const results = mergeRetrievalCandidates({
      denseResults: [
        {
          chunkId: 'chunk-a',
          citation: {
            chunkId: 'chunk-a',
            sourceId: 'source-1',
            title: 'Dense Citation',
          },
          score: 0.92,
          sourceId: 'source-1',
          text: 'Short dense hit',
        },
      ],
      lexicalResults: [
        {
          chunkId: 'chunk-a',
          endOffset: 25,
          metadata: {
            extra: { locale: 'en' },
            tags: ['billing', 'refund'],
          },
          score: 11,
          sourceId: 'source-1',
          sourceName: 'Billing FAQ',
          startOffset: 0,
          text: 'Longer lexical hit with more detail',
          title: 'Refund Policy',
          url: 'https://example.test/refunds',
        },
      ],
      topK: 1,
    });
    const formatted = formatRetrievedContext(results, {
      includeMetadataKeys: ['tags', 'extra'],
    });

    expect(results[0]).toMatchObject({
      chunkId: 'chunk-a',
      citation: {
        chunkId: 'chunk-a',
        sourceId: 'source-1',
        title: 'Dense Citation',
      },
      denseScore: 0.92,
      endOffset: 25,
      lexicalScore: 11,
      metadata: {
        extra: { locale: 'en' },
        tags: ['billing', 'refund'],
      },
      sourceName: 'Billing FAQ',
      startOffset: 0,
      text: 'Longer lexical hit with more detail',
      title: 'Refund Policy',
      url: 'https://example.test/refunds',
    });
    expect(formatted.text).toContain('Metadata: tags: billing, refund; extra: {"locale":"en"}');
  });
});
