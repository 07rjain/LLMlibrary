import { LLMError } from './errors.js';
import { loadPgPoolConstructor } from './node-pg-loader.js';
import { getEnvironmentVariable } from './runtime.js';
import { estimateTokens } from './utils/token-estimator.js';

import type {
  EmbeddingInputItem,
  EmbeddingProvider,
  EmbeddingProviderOptions,
  EmbeddingPurpose,
  EmbeddingRequestOptions,
  EmbeddingResponse,
  JsonValue,
} from './types.js';

export type RetrievalVisibilityScope = 'bot' | 'tenant' | 'user';

export interface RetrievalFilter {
  botId?: string;
  embeddingProfileId?: string;
  knowledgeSpaceId?: string;
  locale?: string;
  metadata?: Record<string, JsonValue | JsonValue[]>;
  scopeType?: RetrievalVisibilityScope;
  scopeUserId?: string;
  sourceIds?: string[];
  sourceTypes?: string[];
  tenantId?: string;
}

export interface RetrievalCitation {
  chunkId: string;
  endOffset?: number;
  metadata?: Record<string, JsonValue>;
  ordinal?: number;
  sourceId: string;
  sourceName?: string;
  startOffset?: number;
  title?: string;
  url?: string;
}

export interface RetrievalResult {
  chunkId: string;
  citation?: RetrievalCitation;
  denseScore?: number;
  endOffset?: number;
  lexicalScore?: number;
  metadata?: Record<string, JsonValue>;
  rank?: number;
  raw?: unknown;
  score: number;
  sourceId: string;
  sourceName?: string;
  startOffset?: number;
  text: string;
  title?: string;
  url?: string;
}

export interface RetrievalQuery {
  filter?: RetrievalFilter;
  input?: EmbeddingInputItem;
  maxPerSource?: number;
  minScore?: number;
  query: string;
  topK?: number;
}

export interface DenseKnowledgeSearchOptions {
  filter?: RetrievalFilter;
  limit: number;
  minScore?: number;
  queryEmbedding: number[];
}

export interface LexicalKnowledgeSearchOptions {
  filter?: RetrievalFilter;
  limit: number;
  minScore?: number;
  query: string;
}

export interface KnowledgeStore {
  searchByEmbedding(options: DenseKnowledgeSearchOptions): Promise<RetrievalResult[]>;
  searchByText?(options: LexicalKnowledgeSearchOptions): Promise<RetrievalResult[]>;
}

export interface Retriever {
  search(query: RetrievalQuery): Promise<RetrievalResult[]>;
}

export interface RetrievalRerankContext {
  embeddingResponse: EmbeddingResponse;
  mode: 'dense' | 'hybrid';
  query: RetrievalQuery;
}

export type RetrievalRerankHook = (
  results: RetrievalResult[],
  context: RetrievalRerankContext,
) => Promise<RetrievalResult[]> | RetrievalResult[];

export interface EmbeddingInvoker {
  embed(options: EmbeddingRequestOptions): Promise<EmbeddingResponse>;
}

export type EmbedFunction = (
  options: EmbeddingRequestOptions,
) => Promise<EmbeddingResponse>;

export interface DenseRetrieverEmbeddingOptions {
  dimensions?: number;
  model?: string;
  provider?: EmbeddingProvider;
  providerOptions?: EmbeddingProviderOptions;
  purpose?: EmbeddingRequestOptions['purpose'];
}

export interface DenseRetrieverOptions {
  defaultMinScore?: number;
  defaultTopK?: number;
  embed: EmbedFunction | EmbeddingInvoker;
  embedding?: DenseRetrieverEmbeddingOptions;
  rerank?: RetrievalRerankHook;
  store: KnowledgeStore;
}

export interface HybridRetrieverOptions extends DenseRetrieverOptions {
  defaultDenseK?: number;
  defaultLexicalK?: number;
  denseWeight?: number;
  fusionK?: number;
  lexicalWeight?: number;
}

export interface MergeRetrievalCandidatesOptions {
  denseResults?: RetrievalResult[];
  denseWeight?: number;
  fusionK?: number;
  lexicalResults?: RetrievalResult[];
  lexicalWeight?: number;
  maxPerSource?: number;
  topK?: number;
}

export type RetrievalScoreDisplay = 'raw' | 'relative_top_1';

export interface FormatRetrievedContextOptions {
  header?: string;
  includeMetadataKeys?: string[];
  includeScores?: boolean;
  maxPerSource?: number;
  maxResults?: number;
  maxTokens?: number;
  scoreDisplay?: RetrievalScoreDisplay;
}

export interface FormattedRetrievedContext {
  citations: RetrievalCitation[];
  estimatedTokens: number;
  omittedCount: number;
  text: string;
  truncated: boolean;
  usedResults: RetrievalResult[];
}

const DEFAULT_RETRIEVAL_TOP_K = 8;
const DEFAULT_FUSION_K = 60;
const TRUNCATION_MARKER = '\n[truncated]';

export function createDenseRetriever(options: DenseRetrieverOptions): Retriever {
  const embed = resolveEmbedFunction(options.embed);
  const defaultTopK = Math.max(options.defaultTopK ?? DEFAULT_RETRIEVAL_TOP_K, 1);

  return {
    async search(query): Promise<RetrievalResult[]> {
      const embeddingResponse = await embed(
        buildEmbeddingRequestOptions(options.embedding, query),
      );
      const embedding = embeddingResponse.embeddings[0]?.values;

      if (!embedding) {
        throw new LLMError('Embedding response did not contain any vectors.', {
          model: embeddingResponse.model,
          provider: embeddingResponse.provider,
        });
      }

      const results = await options.store.searchByEmbedding(
        buildDenseSearchOptions(
          query.filter,
          Math.max(query.topK ?? defaultTopK, 1),
          query.minScore ?? options.defaultMinScore,
          embedding,
        ),
      );
      const reranked = await applyRerankHook(options.rerank, results, {
        embeddingResponse,
        mode: 'dense',
        query,
      });

      return limitRetrievalResults(
        reranked,
        buildLimitOptions(query.maxPerSource, query.topK ?? defaultTopK),
      );
    },
  };
}

export function createHybridRetriever(options: HybridRetrieverOptions): Retriever {
  const embed = resolveEmbedFunction(options.embed);
  const defaultTopK = Math.max(options.defaultTopK ?? DEFAULT_RETRIEVAL_TOP_K, 1);
  const denseLimitDefault = Math.max(options.defaultDenseK ?? defaultTopK, 1);
  const lexicalLimitDefault = Math.max(options.defaultLexicalK ?? defaultTopK, 1);

  return {
    async search(query): Promise<RetrievalResult[]> {
      if (!options.store.searchByText) {
        throw new LLMError(
          'Hybrid retrieval requires knowledgeStore.searchByText() support.',
        );
      }

      const embeddingResponse = await embed(
        buildEmbeddingRequestOptions(options.embedding, query),
      );
      const embedding = embeddingResponse.embeddings[0]?.values;

      if (!embedding) {
        throw new LLMError('Embedding response did not contain any vectors.', {
          model: embeddingResponse.model,
          provider: embeddingResponse.provider,
        });
      }

      const requestedTopK = Math.max(query.topK ?? defaultTopK, 1);
      const denseLimit = Math.max(requestedTopK, denseLimitDefault);
      const lexicalLimit = Math.max(requestedTopK, lexicalLimitDefault);
      const [denseResults, lexicalResults] = await Promise.all([
        options.store.searchByEmbedding(
          buildDenseSearchOptions(
            query.filter,
            denseLimit,
            query.minScore ?? options.defaultMinScore,
            embedding,
          ),
        ),
        options.store.searchByText(
          buildLexicalSearchOptions(
            query.filter,
            lexicalLimit,
            query.minScore ?? options.defaultMinScore,
            query.query,
          ),
        ),
      ]);
      const merged = mergeRetrievalCandidates({
        denseResults,
        lexicalResults,
        topK: requestedTopK,
        ...buildHybridMergeOptions(
          options.denseWeight,
          options.fusionK,
          options.lexicalWeight,
          query.maxPerSource,
        ),
      });
      const reranked = await applyRerankHook(options.rerank, merged, {
        embeddingResponse,
        mode: 'hybrid',
        query,
      });

      return limitRetrievalResults(
        reranked,
        buildLimitOptions(query.maxPerSource, requestedTopK),
      );
    },
  };
}

export function mergeRetrievalCandidates(
  options: MergeRetrievalCandidatesOptions,
): RetrievalResult[] {
  const fusionK = options.fusionK ?? DEFAULT_FUSION_K;
  const denseWeight = options.denseWeight ?? 1;
  const lexicalWeight = options.lexicalWeight ?? 1;
  const merged = new Map<string, AggregatedRetrievalResult>();

  applyReciprocalRankFusion(
    merged,
    options.denseResults ?? [],
    denseWeight,
    fusionK,
    'dense',
  );
  applyReciprocalRankFusion(
    merged,
    options.lexicalResults ?? [],
    lexicalWeight,
    fusionK,
    'lexical',
  );

  const ranked = Array.from(merged.values())
    .sort((left, right) => right.fusionScore - left.fusionScore)
    .map((entry, index) => {
      const result: RetrievalResult = {
        ...entry.result,
        citation: entry.result.citation ?? buildCitation(entry.result),
        rank: index + 1,
        score: roundNumber(entry.fusionScore),
      };

      if (entry.denseScore !== undefined) {
        result.denseScore = entry.denseScore;
      }

      if (entry.lexicalScore !== undefined) {
        result.lexicalScore = entry.lexicalScore;
      }

      return result;
    });

  return limitRetrievalResults(
    ranked,
    buildLimitOptions(options.maxPerSource, options.topK),
  );
}

export function formatRetrievedContext(
  results: RetrievalResult[],
  options: FormatRetrievedContextOptions = {},
): FormattedRetrievedContext {
  const limited = limitRetrievalResults(
    results,
    buildLimitOptions(options.maxPerSource, options.maxResults),
  );

  if (limited.length === 0) {
    return {
      citations: [],
      estimatedTokens: 0,
      omittedCount: 0,
      text: '',
      truncated: false,
      usedResults: [],
    };
  }

  const header = options.header ?? 'Retrieved context';
  const includeScores = options.includeScores ?? false;
  const includeMetadataKeys = options.includeMetadataKeys ?? [];
  const maxTokens = options.maxTokens;
  const scoreDisplay = options.scoreDisplay ?? 'raw';
  const scoreDisplayTopScore = limited[0]?.score;
  const headerPrefix = `${header}\n\n`;
  const blocks: string[] = [];
  const usedResults: RetrievalResult[] = [];
  const citations: RetrievalCitation[] = [];
  let estimatedTokens = estimateTokens(headerPrefix);
  let truncated = false;

  for (const [index, result] of limited.entries()) {
    const ordinal = index + 1;
    const prefix = buildContextBlockPrefix(
      result,
      ordinal,
      includeScores,
      includeMetadataKeys,
      scoreDisplay,
      scoreDisplayTopScore,
    );
    const fullBlock = `${prefix}${result.text.trim()}`;
    const fullBlockTokens = estimateTokens(fullBlock);

    if (maxTokens === undefined || estimatedTokens + fullBlockTokens <= maxTokens) {
      blocks.push(fullBlock);
      estimatedTokens += fullBlockTokens;
      usedResults.push(withCitationOrdinal(result, ordinal));
      citations.push({ ...buildCitation(result), ordinal });
      continue;
    }

    const remainingTokens = maxTokens - estimatedTokens;

    if (remainingTokens <= 0) {
      truncated = true;
      break;
    }

    const prefixTokens = estimateTokens(prefix);
    const availableTextTokens = remainingTokens - prefixTokens - estimateTokens(TRUNCATION_MARKER);
    const minimumFallbackTextTokens = Math.max(
      remainingTokens - estimateTokens(TRUNCATION_MARKER),
      0,
    );

    if (availableTextTokens <= 0) {
      if (usedResults.length > 0 || minimumFallbackTextTokens <= 0) {
        truncated = true;
        break;
      }

      const fallbackPrefix = `[${ordinal}] Source: ${formatSourceLabel(result)}\n`;
      const fallbackPrefixTokens = estimateTokens(fallbackPrefix);
      const fallbackAvailableTextTokens =
        remainingTokens -
        fallbackPrefixTokens -
        estimateTokens(TRUNCATION_MARKER);

      if (fallbackAvailableTextTokens <= 0) {
        truncated = true;
        break;
      }

      const fallbackText = truncateTextToTokenBudget(
        result.text.trim(),
        fallbackAvailableTextTokens,
      );
      const fallbackBlock = `${fallbackPrefix}${fallbackText}${TRUNCATION_MARKER}`;
      blocks.push(fallbackBlock);
      estimatedTokens += estimateTokens(fallbackBlock);
      usedResults.push(withCitationOrdinal(result, ordinal));
      citations.push({ ...buildCitation(result), ordinal });
      truncated = true;
      break;
    }

    const truncatedText = truncateTextToTokenBudget(result.text.trim(), availableTextTokens);
    const truncatedBlock = `${prefix}${truncatedText}${TRUNCATION_MARKER}`;
    const truncatedBlockTokens = estimateTokens(truncatedBlock);

    blocks.push(truncatedBlock);
    estimatedTokens += truncatedBlockTokens;
    usedResults.push(withCitationOrdinal(result, ordinal));
    citations.push({ ...buildCitation(result), ordinal });
    truncated = true;
    break;
  }

  return {
    citations,
    estimatedTokens,
    omittedCount: Math.max(limited.length - usedResults.length, 0),
    text: `${headerPrefix}${blocks.join('\n\n')}`,
    truncated,
    usedResults,
  };
}

interface AggregatedRetrievalResult {
  denseScore?: number;
  fusionScore: number;
  lexicalScore?: number;
  result: RetrievalResult;
}

interface LimitRetrievalResultsOptions {
  maxPerSource?: number;
  topK?: number;
}

function applyReciprocalRankFusion(
  merged: Map<string, AggregatedRetrievalResult>,
  results: RetrievalResult[],
  weight: number,
  fusionK: number,
  strategy: 'dense' | 'lexical',
): void {
  for (const [index, result] of results.entries()) {
    const key = getRetrievalResultKey(result);
    const existing = merged.get(key);
    const fusionScore = weight / (fusionK + index + 1);

    if (!existing) {
      const entry: AggregatedRetrievalResult = {
        fusionScore,
        result: result.citation ? result : { ...result, citation: buildCitation(result) },
      };

      if (strategy === 'dense') {
        entry.denseScore = result.score;
      } else {
        entry.lexicalScore = result.score;
      }

      merged.set(key, entry);
      continue;
    }

    existing.fusionScore += fusionScore;
    existing.result = mergeRetrievalResultDetails(existing.result, result);
    if (strategy === 'dense') {
      existing.denseScore = result.score;
    } else {
      existing.lexicalScore = result.score;
    }
  }
}

function buildCitation(result: RetrievalResult): RetrievalCitation {
  if (result.citation) {
    return result.citation;
  }

  const citation: RetrievalCitation = {
    chunkId: result.chunkId,
    sourceId: result.sourceId,
  };

  if (result.endOffset !== undefined) {
    citation.endOffset = result.endOffset;
  }

  if (result.metadata) {
    citation.metadata = result.metadata;
  }

  if (result.sourceName) {
    citation.sourceName = result.sourceName;
  }

  if (result.startOffset !== undefined) {
    citation.startOffset = result.startOffset;
  }

  if (result.title) {
    citation.title = result.title;
  }

  if (result.url) {
    citation.url = result.url;
  }

  return citation;
}

function buildContextBlockPrefix(
  result: RetrievalResult,
  ordinal: number,
  includeScores: boolean,
  includeMetadataKeys: string[],
  scoreDisplay: RetrievalScoreDisplay,
  scoreDisplayTopScore: number | undefined,
): string {
  const lines = [`[${ordinal}] Source: ${formatSourceLabel(result)}`];

  if (includeScores) {
    lines.push(formatScoreLine(result, scoreDisplay, scoreDisplayTopScore));
  }

  const metadataEntries = includeMetadataKeys.flatMap((key) => {
    const value = result.metadata?.[key];
    return value === undefined ? [] : `${key}: ${formatMetadataValue(value)}`;
  });

  if (metadataEntries.length > 0) {
    lines.push(`Metadata: ${metadataEntries.join('; ')}`);
  }

  return `${lines.join('\n')}\n`;
}

function formatScoreLine(
  result: RetrievalResult,
  scoreDisplay: RetrievalScoreDisplay,
  topScore: number | undefined,
): string {
  if (scoreDisplay === 'relative_top_1') {
    const normalizedScore = normalizeScoreRelativeToTopResult(result.score, topScore);
    if (normalizedScore !== undefined) {
      return `Score (relative to top result; display-only, not a probability): ${normalizedScore.toFixed(4)}`;
    }
  }

  return `Score (${describeRawScore(result)}; not a probability): ${result.score.toFixed(4)}`;
}

function describeRawScore(result: RetrievalResult): string {
  if (result.denseScore !== undefined && result.lexicalScore !== undefined) {
    return 'raw fused rank score';
  }

  if (result.denseScore !== undefined) {
    return 'raw dense similarity';
  }

  if (result.lexicalScore !== undefined) {
    return 'raw lexical relevance';
  }

  return 'raw retrieval score';
}

function formatMetadataValue(value: JsonValue): string {
  if (Array.isArray(value)) {
    return value.map((item) => formatMetadataValue(item)).join(', ');
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function formatSourceLabel(result: RetrievalResult): string {
  return result.title ?? result.sourceName ?? result.sourceId;
}

function normalizeScoreRelativeToTopResult(
  score: number,
  topScore: number | undefined,
): number | undefined {
  if (topScore === undefined || topScore <= 0) {
    return undefined;
  }

  return score / topScore;
}

function getRetrievalResultKey(result: RetrievalResult): string {
  return `${result.sourceId}:${result.chunkId}`;
}

function limitRetrievalResults(
  results: RetrievalResult[],
  options: LimitRetrievalResultsOptions,
): RetrievalResult[] {
  const topK = options.topK;
  const maxPerSource = options.maxPerSource;
  const sourceCounts = new Map<string, number>();
  const limited: RetrievalResult[] = [];

  for (const result of results) {
    if (topK !== undefined && limited.length >= topK) {
      break;
    }

    const sourceCount = sourceCounts.get(result.sourceId) ?? 0;

    if (maxPerSource !== undefined && sourceCount >= maxPerSource) {
      continue;
    }

    limited.push(result);
    sourceCounts.set(result.sourceId, sourceCount + 1);
  }

  return limited;
}

function mergeRetrievalResultDetails(
  current: RetrievalResult,
  incoming: RetrievalResult,
): RetrievalResult {
  const merged: RetrievalResult = {
    chunkId: current.chunkId,
    score: current.score,
    sourceId: current.sourceId,
    text: current.text.length >= incoming.text.length ? current.text : incoming.text,
  };
  const citation = current.citation ?? incoming.citation;
  const denseScore = current.denseScore ?? incoming.denseScore;
  const endOffset = current.endOffset ?? incoming.endOffset;
  const lexicalScore = current.lexicalScore ?? incoming.lexicalScore;
  const metadata = current.metadata ?? incoming.metadata;
  const rank = current.rank ?? incoming.rank;
  const raw = current.raw ?? incoming.raw;
  const sourceName = current.sourceName ?? incoming.sourceName;
  const startOffset = current.startOffset ?? incoming.startOffset;
  const title = current.title ?? incoming.title;
  const url = current.url ?? incoming.url;

  if (citation !== undefined) {
    merged.citation = citation;
  }

  if (denseScore !== undefined) {
    merged.denseScore = denseScore;
  }

  if (endOffset !== undefined) {
    merged.endOffset = endOffset;
  }

  if (lexicalScore !== undefined) {
    merged.lexicalScore = lexicalScore;
  }

  if (metadata !== undefined) {
    merged.metadata = metadata;
  }

  if (rank !== undefined) {
    merged.rank = rank;
  }

  if (raw !== undefined) {
    merged.raw = raw;
  }

  if (sourceName !== undefined) {
    merged.sourceName = sourceName;
  }

  if (startOffset !== undefined) {
    merged.startOffset = startOffset;
  }

  if (title !== undefined) {
    merged.title = title;
  }

  if (url !== undefined) {
    merged.url = url;
  }

  return merged;
}

function resolveEmbedFunction(embed: DenseRetrieverOptions['embed']): EmbedFunction {
  if (typeof embed === 'function') {
    return embed;
  }

  return embed.embed.bind(embed);
}

async function applyRerankHook(
  rerank: RetrievalRerankHook | undefined,
  results: RetrievalResult[],
  context: RetrievalRerankContext,
): Promise<RetrievalResult[]> {
  if (!rerank) {
    return results;
  }

  const reranked = await rerank(results, context);
  if (!Array.isArray(reranked)) {
    throw new LLMError('Retrieval rerank hooks must return an array of results.');
  }

  return reranked;
}

function roundNumber(value: number): number {
  return Number(value.toFixed(8));
}

function assertInMemoryEmbeddingProfileImmutability(
  existing: EmbeddingProfileRecord,
  incoming: EmbeddingProfileRecord,
): void {
  const immutableChanges: string[] = [];
  if (existing.knowledgeSpaceId !== incoming.knowledgeSpaceId) {
    immutableChanges.push('knowledgeSpaceId');
  }
  if (existing.tenantId !== incoming.tenantId) {
    immutableChanges.push('tenantId');
  }
  if (existing.botId !== incoming.botId) {
    immutableChanges.push('botId');
  }
  if (existing.provider !== incoming.provider) {
    immutableChanges.push('provider');
  }
  if (existing.model !== incoming.model) {
    immutableChanges.push('model');
  }
  if (existing.dimensions !== incoming.dimensions) {
    immutableChanges.push('dimensions');
  }
  if ((existing.distanceMetric ?? 'cosine') !== (incoming.distanceMetric ?? 'cosine')) {
    immutableChanges.push('distanceMetric');
  }
  if ((existing.taskInstruction ?? null) !== (incoming.taskInstruction ?? null)) {
    immutableChanges.push('taskInstruction');
  }

  const existingPurposes = JSON.stringify(existing.purposeDefaults ?? []);
  const incomingPurposes = JSON.stringify(incoming.purposeDefaults ?? []);
  if (existingPurposes !== incomingPurposes) {
    immutableChanges.push('purposeDefaults');
  }

  if (immutableChanges.length > 0) {
    throw new LLMError(
      `Embedding profiles are immutable. Create a new profile id instead of changing: ${immutableChanges.join(', ')}.`,
    );
  }
}

function buildInMemoryRetrievalResult(
  chunk: KnowledgeChunkRecord,
  source: KnowledgeSourceRecord,
  score: number,
): RetrievalResult {
  const result: RetrievalResult = {
    chunkId: chunk.id,
    raw: { chunk, source },
    score,
    sourceId: chunk.sourceId,
    sourceName: chunk.sourceName ?? source.name,
    text: chunk.text,
    title: chunk.title ?? source.title ?? source.name,
    ...(chunk.endOffset !== undefined ? { endOffset: chunk.endOffset } : {}),
    ...(chunk.metadata ? { metadata: chunk.metadata } : {}),
    ...(chunk.startOffset !== undefined ? { startOffset: chunk.startOffset } : {}),
    ...(chunk.url ?? source.canonicalUrl
      ? { url: chunk.url ?? source.canonicalUrl }
      : {}),
  };

  result.citation = chunk.citation ?? buildCitation(result);
  return result;
}

function calculateCosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return Number.NaN;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      return Number.NaN;
    }

    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return Number.NaN;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function calculateLexicalSearchScore(
  query: string,
  chunk: KnowledgeChunkRecord,
  source: KnowledgeSourceRecord,
): number {
  const normalizedQuery = normalizeLexicalText(query);
  if (normalizedQuery.length === 0) {
    return 0;
  }

  const haystack = normalizeLexicalText(
    [chunk.title, source.title, source.name, chunk.text].filter(Boolean).join('\n'),
  );
  if (haystack.length === 0) {
    return 0;
  }

  const tokens = tokenizeLexicalQuery(normalizedQuery);
  if (tokens.length === 0) {
    return 0;
  }

  let score = 0;
  for (const token of tokens) {
    const occurrences = countLexicalOccurrences(haystack, token);
    if (occurrences > 0) {
      score += occurrences * 2;
    }
  }

  if (haystack.includes(normalizedQuery)) {
    score += tokens.length * 3;
  }

  if ((chunk.title ?? source.title ?? '').toLowerCase().includes(normalizedQuery)) {
    score += 4;
  }

  return score;
}

function compareKnowledgeSourcesByUpdatedAtDesc(
  left: KnowledgeSourceRecord,
  right: KnowledgeSourceRecord,
): number {
  const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? '') || 0;
  const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? '') || 0;

  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return left.id.localeCompare(right.id);
}

function compareRetrievalResultsByScore(
  left: RetrievalResult,
  right: RetrievalResult,
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.chunkId.localeCompare(right.chunkId);
}

function countLexicalOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;

  while (position < haystack.length) {
    const nextIndex = haystack.indexOf(needle, position);
    if (nextIndex === -1) {
      break;
    }

    count += 1;
    position = nextIndex + needle.length;
  }

  return count;
}

function matchesInMemoryRetrievalFilter(
  chunk: KnowledgeChunkRecord,
  source: KnowledgeSourceRecord,
  filter: RetrievalFilter | undefined,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.tenantId && chunk.tenantId !== filter.tenantId) {
    return false;
  }
  if (filter.botId && chunk.botId !== filter.botId) {
    return false;
  }
  if (filter.knowledgeSpaceId && chunk.knowledgeSpaceId !== filter.knowledgeSpaceId) {
    return false;
  }
  if (filter.embeddingProfileId && chunk.embeddingProfileId !== filter.embeddingProfileId) {
    return false;
  }
  if (filter.scopeType && (chunk.scopeType ?? 'bot') !== filter.scopeType) {
    return false;
  }
  if (filter.scopeUserId && chunk.scopeUserId !== filter.scopeUserId) {
    return false;
  }
  if (filter.sourceIds && filter.sourceIds.length > 0 && !filter.sourceIds.includes(chunk.sourceId)) {
    return false;
  }
  if (
    filter.sourceTypes &&
    filter.sourceTypes.length > 0 &&
    !filter.sourceTypes.includes(chunk.sourceType ?? source.sourceType)
  ) {
    return false;
  }
  if (filter.locale) {
    const localeValue =
      typeof chunk.metadata?.locale === 'string'
        ? chunk.metadata.locale
        : typeof source.metadata?.locale === 'string'
          ? source.metadata.locale
          : undefined;

    if (localeValue !== filter.locale) {
      return false;
    }
  }
  if (filter.metadata && !matchesJsonRecordSubset(chunk.metadata ?? {}, filter.metadata)) {
    return false;
  }

  return true;
}

function matchesJsonRecordSubset(
  actual: Record<string, JsonValue>,
  expected: Record<string, JsonValue | JsonValue[]>,
): boolean {
  return Object.entries(expected).every(([key, expectedValue]) =>
    matchesJsonValue(actual[key], expectedValue),
  );
}

function matchesJsonValue(
  actual: JsonValue | undefined,
  expected: JsonValue | JsonValue[],
): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return false;
    }

    return expected.every((expectedItem) =>
      actual.some((actualItem) => JSON.stringify(actualItem) === JSON.stringify(expectedItem)),
    );
  }

  return JSON.stringify(actual) === JSON.stringify(expected);
}

function normalizeLexicalText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeLexicalQuery(query: string): string[] {
  return Array.from(new Set(query.split(' ').filter((token) => token.length > 0)));
}

function truncateTextToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || text.length === 0) {
    return '';
  }

  if (estimateTokens(text) <= tokenBudget) {
    return text;
  }

  let low = 0;
  let high = text.length;
  let best = '';

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(0, middle).trimEnd();
    const candidateTokens = estimateTokens(candidate);

    if (candidateTokens <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return best;
}

function withCitationOrdinal(
  result: RetrievalResult,
  ordinal: number,
): RetrievalResult {
  return {
    ...result,
    citation: {
      ...buildCitation(result),
      ordinal,
    },
  };
}

function buildDenseSearchOptions(
  filter: RetrievalFilter | undefined,
  limit: number,
  minScore: number | undefined,
  queryEmbedding: number[],
): DenseKnowledgeSearchOptions {
  return {
    limit,
    queryEmbedding,
    ...(filter ? { filter } : {}),
    ...(minScore !== undefined ? { minScore } : {}),
  };
}

function buildEmbeddingRequestOptions(
  embeddingOptions: DenseRetrieverEmbeddingOptions | undefined,
  query: RetrievalQuery,
): EmbeddingRequestOptions {
  return {
    input: query.input ?? query.query,
    purpose: embeddingOptions?.purpose ?? 'retrieval_query',
    ...(query.filter?.botId ? { botId: query.filter.botId } : {}),
    ...(embeddingOptions?.dimensions !== undefined
      ? { dimensions: embeddingOptions.dimensions }
      : {}),
    ...(embeddingOptions?.model ? { model: embeddingOptions.model } : {}),
    ...(embeddingOptions?.provider ? { provider: embeddingOptions.provider } : {}),
    ...(embeddingOptions?.providerOptions
      ? { providerOptions: embeddingOptions.providerOptions }
      : {}),
    ...(query.filter?.tenantId ? { tenantId: query.filter.tenantId } : {}),
  };
}

function buildHybridMergeOptions(
  denseWeight: number | undefined,
  fusionK: number | undefined,
  lexicalWeight: number | undefined,
  maxPerSource: number | undefined,
): Omit<MergeRetrievalCandidatesOptions, 'denseResults' | 'lexicalResults' | 'topK'> {
  return {
    ...(denseWeight !== undefined ? { denseWeight } : {}),
    ...(fusionK !== undefined ? { fusionK } : {}),
    ...(lexicalWeight !== undefined ? { lexicalWeight } : {}),
    ...(maxPerSource !== undefined ? { maxPerSource } : {}),
  };
}

function buildLexicalSearchOptions(
  filter: RetrievalFilter | undefined,
  limit: number,
  minScore: number | undefined,
  query: string,
): LexicalKnowledgeSearchOptions {
  return {
    limit,
    query,
    ...(filter ? { filter } : {}),
    ...(minScore !== undefined ? { minScore } : {}),
  };
}

function buildLimitOptions(
  maxPerSource: number | undefined,
  topK: number | undefined,
): LimitRetrievalResultsOptions {
  return {
    ...(maxPerSource !== undefined ? { maxPerSource } : {}),
    ...(topK !== undefined ? { topK } : {}),
  };
}

export type KnowledgeSourceStatus =
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'needs_reindex';

export type PostgresDistanceMetric = 'cosine' | 'inner_product' | 'l2';

export interface PostgresKnowledgeStoreQueryResult<TRow = Record<string, unknown>> {
  rowCount?: null | number;
  rows: TRow[];
}

export interface PostgresKnowledgeStorePool {
  end?: () => Promise<void>;
  query: <TRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<PostgresKnowledgeStoreQueryResult<TRow>>;
}

export interface PostgresKnowledgeStoreTableNames {
  chunks?: string;
  profiles?: string;
  sources?: string;
  spaces?: string;
}

export interface PostgresKnowledgeStoreOptions {
  connectionString?: string;
  ensureVectorExtension?: boolean;
  now?: () => Date;
  pool?: PostgresKnowledgeStorePool;
  schemaName?: string;
  searchConfig?: string;
  tableNames?: PostgresKnowledgeStoreTableNames;
}

export interface PostgresKnowledgeSpaceRecord {
  activeEmbeddingProfileId?: string;
  botId: string;
  createdAt?: string;
  id: string;
  metadata?: Record<string, JsonValue>;
  name: string;
  tenantId: string;
  updatedAt?: string;
  visibilityScope?: RetrievalVisibilityScope;
}

export interface PostgresEmbeddingProfileRecord {
  botId: string;
  createdAt?: string;
  dimensions: number;
  distanceMetric?: PostgresDistanceMetric;
  id: string;
  knowledgeSpaceId: string;
  model: string;
  provider: EmbeddingProvider;
  purposeDefaults?: EmbeddingPurpose[];
  status?: string;
  taskInstruction?: string;
  tenantId: string;
  updatedAt?: string;
}

export interface PostgresActiveEmbeddingProfileFilter {
  botId: string;
  knowledgeSpaceId: string;
  tenantId: string;
}

export interface PostgresActivateEmbeddingProfileOptions
  extends PostgresActiveEmbeddingProfileFilter {
  embeddingProfileId: string;
}

export interface PostgresKnowledgeSourceRecord {
  botId: string;
  canonicalUrl?: string;
  checksum?: string;
  createdAt?: string;
  embeddingProfileId?: string;
  errorMessage?: string;
  externalId?: string;
  id: string;
  knowledgeSpaceId: string;
  metadata?: Record<string, JsonValue>;
  name: string;
  progressPercent?: number;
  sourceType: string;
  status?: KnowledgeSourceStatus;
  tenantId: string;
  title?: string;
  updatedAt?: string;
}

export interface PostgresKnowledgeSourceListOptions {
  botId: string;
  embeddingProfileId?: string;
  knowledgeSpaceId: string;
  limit?: number;
  statuses?: KnowledgeSourceStatus[];
  tenantId: string;
}

export interface PostgresMarkKnowledgeSourcesNeedingReindexOptions {
  botId: string;
  fromEmbeddingProfileId?: string;
  knowledgeSpaceId: string;
  tenantId: string;
  toEmbeddingProfileId: string;
}

export interface PostgresKnowledgeChunkRecord {
  botId: string;
  chunkIndex: number;
  citation?: RetrievalCitation;
  createdAt?: string;
  embedding: number[];
  embeddingProfileId: string;
  endOffset?: number;
  id: string;
  knowledgeSpaceId: string;
  metadata?: Record<string, JsonValue>;
  scopeType?: RetrievalVisibilityScope;
  scopeUserId?: string;
  sourceId: string;
  sourceName?: string;
  sourceType?: string;
  startOffset?: number;
  tenantId: string;
  text: string;
  title?: string;
  tokenCount?: number;
  updatedAt?: string;
  url?: string;
}

export interface PgvectorHnswIndexOptions {
  chunksTableName?: string;
  dimensions: number;
  distanceMetric?: PostgresDistanceMetric;
  embeddingProfileId: string;
  indexName?: string;
  schemaName?: string;
}

export type KnowledgeSpaceRecord = PostgresKnowledgeSpaceRecord;
export type EmbeddingProfileRecord = PostgresEmbeddingProfileRecord;
export type ActiveEmbeddingProfileFilter = PostgresActiveEmbeddingProfileFilter;
export type ActivateEmbeddingProfileOptions = PostgresActivateEmbeddingProfileOptions;
export type KnowledgeSourceRecord = PostgresKnowledgeSourceRecord;
export type KnowledgeSourceListOptions = PostgresKnowledgeSourceListOptions;
export type MarkKnowledgeSourcesNeedingReindexOptions =
  PostgresMarkKnowledgeSourcesNeedingReindexOptions;
export type KnowledgeChunkRecord = PostgresKnowledgeChunkRecord;

export interface InMemoryKnowledgeStoreOptions {
  now?: () => Date;
}

interface PostgresKnowledgeSearchRow {
  chunk_id: string;
  chunk_text: string;
  citation: null | Record<string, unknown>;
  end_offset: null | number;
  metadata: null | Record<string, JsonValue>;
  score: number | string;
  source_id: string;
  source_name: null | string;
  start_offset: null | number;
  title: null | string;
  url: null | string;
}

interface PostgresEmbeddingProfileRow {
  bot_id: string;
  created_at: string;
  dimensions: number;
  distance_metric: PostgresDistanceMetric;
  id: string;
  knowledge_space_id: string;
  model: string;
  provider: EmbeddingProvider;
  purpose_defaults: JsonValue;
  status: string;
  task_instruction: null | string;
  tenant_id: string;
  updated_at: string;
}

interface PostgresKnowledgeSourceRow {
  bot_id: string;
  canonical_url: null | string;
  checksum: null | string;
  created_at: string;
  embedding_profile_id: null | string;
  error_message: null | string;
  external_id: null | string;
  id: string;
  knowledge_space_id: string;
  metadata: JsonValue;
  name: string;
  progress_percent: number;
  source_type: string;
  status: KnowledgeSourceStatus;
  tenant_id: string;
  title: null | string;
  updated_at: string;
}

const DEFAULT_POSTGRES_SEARCH_CONFIG = 'english';
const DEFAULT_POSTGRES_SCHEMA = 'public';
const DEFAULT_POSTGRES_TABLE_NAMES = {
  chunks: 'knowledge_chunks',
  profiles: 'embedding_profiles',
  sources: 'knowledge_sources',
  spaces: 'knowledge_spaces',
} as const;

export function createPostgresKnowledgeStore(
  options: PostgresKnowledgeStoreOptions = {},
): PostgresKnowledgeStore {
  return new PostgresKnowledgeStore(options);
}

export function createPgvectorHnswIndexSql(
  options: PgvectorHnswIndexOptions,
): string {
  const schemaName = options.schemaName ?? DEFAULT_POSTGRES_SCHEMA;
  const chunksTableName = options.chunksTableName ?? DEFAULT_POSTGRES_TABLE_NAMES.chunks;
  const distanceMetric = options.distanceMetric ?? 'cosine';
  const opClass = getPgvectorOperatorClass(distanceMetric);
  const indexName =
    options.indexName ??
    buildSafeIndexName(
      `${chunksTableName}_${options.embeddingProfileId}_${distanceMetric}_hnsw_idx`,
    );

  return `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)}
ON ${quoteIdentifier(schemaName)}.${quoteIdentifier(chunksTableName)}
USING hnsw ((embedding::vector(${options.dimensions})) ${opClass})
WHERE embedding_profile_id = ${quoteLiteral(options.embeddingProfileId)} AND embedding IS NOT NULL;`;
}

export function createInMemoryKnowledgeStore(
  options: InMemoryKnowledgeStoreOptions = {},
): InMemoryKnowledgeStore {
  return new InMemoryKnowledgeStore(options);
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly chunks = new Map<string, KnowledgeChunkRecord>();
  private readonly now: () => Date;
  private readonly profiles = new Map<string, EmbeddingProfileRecord>();
  private readonly sources = new Map<string, KnowledgeSourceRecord>();
  private readonly spaces = new Map<string, KnowledgeSpaceRecord>();

  constructor(options: InMemoryKnowledgeStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async searchByEmbedding(options: DenseKnowledgeSearchOptions): Promise<RetrievalResult[]> {
    assertQueryEmbedding(options.queryEmbedding);

    const matches = Array.from(this.chunks.values())
      .flatMap((chunk) => {
        const source = this.sources.get(chunk.sourceId);
        if (!source || source.status !== 'ready') {
          return [];
        }

        if (!matchesInMemoryRetrievalFilter(chunk, source, options.filter)) {
          return [];
        }

        const score = calculateCosineSimilarity(options.queryEmbedding, chunk.embedding);
        if (!Number.isFinite(score)) {
          return [];
        }

        const roundedScore = roundNumber(score);
        if (options.minScore !== undefined && roundedScore < options.minScore) {
          return [];
        }

        return [buildInMemoryRetrievalResult(chunk, source, roundedScore)];
      })
      .sort(compareRetrievalResultsByScore)
      .slice(0, Math.max(options.limit, 1));

    return matches;
  }

  async searchByText(options: LexicalKnowledgeSearchOptions): Promise<RetrievalResult[]> {
    const query = options.query.trim();
    if (query.length === 0) {
      return [];
    }

    const matches = Array.from(this.chunks.values())
      .flatMap((chunk) => {
        const source = this.sources.get(chunk.sourceId);
        if (!source || source.status !== 'ready') {
          return [];
        }

        if (!matchesInMemoryRetrievalFilter(chunk, source, options.filter)) {
          return [];
        }

        const score = calculateLexicalSearchScore(query, chunk, source);
        if (!Number.isFinite(score) || score <= 0) {
          return [];
        }

        const roundedScore = roundNumber(score);
        if (options.minScore !== undefined && roundedScore < options.minScore) {
          return [];
        }

        return [buildInMemoryRetrievalResult(chunk, source, roundedScore)];
      })
      .sort(compareRetrievalResultsByScore)
      .slice(0, Math.max(options.limit, 1));

    return matches;
  }

  async activateEmbeddingProfile(
    options: ActivateEmbeddingProfileOptions,
  ): Promise<void> {
    const existing = this.spaces.get(options.knowledgeSpaceId);
    if (!existing || existing.tenantId !== options.tenantId || existing.botId !== options.botId) {
      return;
    }

    const timestamp = this.now().toISOString();
    this.spaces.set(options.knowledgeSpaceId, {
      ...existing,
      activeEmbeddingProfileId: options.embeddingProfileId,
      updatedAt: timestamp,
    });
  }

  async clear(): Promise<void> {
    this.chunks.clear();
    this.profiles.clear();
    this.sources.clear();
    this.spaces.clear();
  }

  async deleteKnowledgeSource(sourceId: string): Promise<void> {
    this.sources.delete(sourceId);
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (chunk.sourceId === sourceId) {
        this.chunks.delete(chunkId);
      }
    }
  }

  async getActiveEmbeddingProfile(
    filter: ActiveEmbeddingProfileFilter,
  ): Promise<EmbeddingProfileRecord | null> {
    const space = this.spaces.get(filter.knowledgeSpaceId);
    if (
      !space ||
      space.tenantId !== filter.tenantId ||
      space.botId !== filter.botId ||
      !space.activeEmbeddingProfileId
    ) {
      return null;
    }

    const profile = this.profiles.get(space.activeEmbeddingProfileId);
    if (
      !profile ||
      profile.tenantId !== filter.tenantId ||
      profile.botId !== filter.botId ||
      profile.knowledgeSpaceId !== filter.knowledgeSpaceId
    ) {
      return null;
    }

    return profile;
  }

  async listKnowledgeSources(
    options: KnowledgeSourceListOptions,
  ): Promise<KnowledgeSourceRecord[]> {
    return Array.from(this.sources.values())
      .filter((source) => source.tenantId === options.tenantId)
      .filter((source) => source.botId === options.botId)
      .filter((source) => source.knowledgeSpaceId === options.knowledgeSpaceId)
      .filter(
        (source) =>
          options.embeddingProfileId === undefined ||
          source.embeddingProfileId === options.embeddingProfileId,
      )
      .filter(
        (source) =>
          !options.statuses ||
          options.statuses.length === 0 ||
          options.statuses.includes(source.status ?? 'queued'),
      )
      .sort(compareKnowledgeSourcesByUpdatedAtDesc)
      .slice(0, Math.max(options.limit ?? 100, 1));
  }

  async markKnowledgeSourcesNeedingReindex(
    options: MarkKnowledgeSourcesNeedingReindexOptions,
  ): Promise<number> {
    const timestamp = this.now().toISOString();
    let updatedCount = 0;

    for (const [sourceId, source] of this.sources.entries()) {
      if (
        source.tenantId !== options.tenantId ||
        source.botId !== options.botId ||
        source.knowledgeSpaceId !== options.knowledgeSpaceId
      ) {
        continue;
      }

      if (
        options.fromEmbeddingProfileId !== undefined &&
        source.embeddingProfileId !== options.fromEmbeddingProfileId
      ) {
        continue;
      }

      if (
        source.embeddingProfileId !== undefined &&
        source.embeddingProfileId === options.toEmbeddingProfileId
      ) {
        continue;
      }

      this.sources.set(sourceId, {
        ...source,
        status: 'needs_reindex',
        updatedAt: timestamp,
      });
      updatedCount += 1;
    }

    return updatedCount;
  }

  async upsertEmbeddingProfile(
    record: EmbeddingProfileRecord,
  ): Promise<EmbeddingProfileRecord> {
    const existing = this.profiles.get(record.id);
    if (existing) {
      assertInMemoryEmbeddingProfileImmutability(existing, record);
    }

    const timestamp = this.now().toISOString();
    const normalized: EmbeddingProfileRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? timestamp,
      updatedAt: record.updatedAt ?? timestamp,
      ...(record.distanceMetric === undefined ? { distanceMetric: 'cosine' } : {}),
      ...(record.purposeDefaults === undefined ? { purposeDefaults: [] } : {}),
      ...(record.status === undefined ? { status: 'active' } : {}),
    };

    this.profiles.set(normalized.id, normalized);
    return normalized;
  }

  async upsertKnowledgeChunk(
    record: KnowledgeChunkRecord,
  ): Promise<KnowledgeChunkRecord> {
    assertQueryEmbedding(record.embedding);

    const existing = this.chunks.get(record.id);
    const timestamp = this.now().toISOString();
    const normalized: KnowledgeChunkRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? timestamp,
      updatedAt: record.updatedAt ?? timestamp,
      ...(record.scopeType === undefined ? { scopeType: 'bot' } : {}),
    };

    this.chunks.set(normalized.id, normalized);
    return normalized;
  }

  async upsertKnowledgeSource(
    record: KnowledgeSourceRecord,
  ): Promise<KnowledgeSourceRecord> {
    const existing = this.sources.get(record.id);
    const timestamp = this.now().toISOString();
    const normalized: KnowledgeSourceRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? timestamp,
      updatedAt: record.updatedAt ?? timestamp,
      ...(record.progressPercent === undefined ? { progressPercent: 0 } : {}),
      ...(record.status === undefined ? { status: 'queued' } : {}),
    };

    this.sources.set(normalized.id, normalized);
    return normalized;
  }

  async upsertKnowledgeSpace(
    record: KnowledgeSpaceRecord,
  ): Promise<KnowledgeSpaceRecord> {
    const existing = this.spaces.get(record.id);
    const timestamp = this.now().toISOString();
    const normalized: KnowledgeSpaceRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? timestamp,
      updatedAt: record.updatedAt ?? timestamp,
      ...(record.visibilityScope === undefined ? { visibilityScope: 'bot' } : {}),
    };

    this.spaces.set(normalized.id, normalized);
    return normalized;
  }
}

export class PostgresKnowledgeStore implements KnowledgeStore {
  private readonly connectionString: string | undefined;
  private ensureSchemaPromise: null | Promise<void> = null;
  private readonly ensureVectorExtension: boolean;
  private internalPool: PostgresKnowledgeStorePool | undefined;
  private readonly now: () => Date;
  private readonly pool: PostgresKnowledgeStorePool | undefined;
  private readonly schemaName: string;
  private readonly searchConfig: string;
  private readonly tableNames: Required<PostgresKnowledgeStoreTableNames>;

  constructor(options: PostgresKnowledgeStoreOptions = {}) {
    this.connectionString = options.connectionString;
    this.ensureVectorExtension = options.ensureVectorExtension ?? true;
    this.now = options.now ?? (() => new Date());
    this.pool = options.pool;
    this.schemaName = options.schemaName ?? DEFAULT_POSTGRES_SCHEMA;
    this.searchConfig = options.searchConfig ?? DEFAULT_POSTGRES_SEARCH_CONFIG;
    this.tableNames = {
      chunks: options.tableNames?.chunks ?? DEFAULT_POSTGRES_TABLE_NAMES.chunks,
      profiles: options.tableNames?.profiles ?? DEFAULT_POSTGRES_TABLE_NAMES.profiles,
      sources: options.tableNames?.sources ?? DEFAULT_POSTGRES_TABLE_NAMES.sources,
      spaces: options.tableNames?.spaces ?? DEFAULT_POSTGRES_TABLE_NAMES.spaces,
    };
  }

  static fromEnv(
    options: Omit<PostgresKnowledgeStoreOptions, 'connectionString'> = {},
  ): PostgresKnowledgeStore {
    const connectionString = getEnvironmentVariable('DATABASE_URL');
    return new PostgresKnowledgeStore({
      ...options,
      ...(connectionString ? { connectionString } : {}),
    });
  }

  async close(): Promise<void> {
    if (!this.internalPool?.end) {
      return;
    }

    await this.internalPool.end();
    this.internalPool = undefined;
    this.ensureSchemaPromise = null;
  }

  async ensureSchema(): Promise<void> {
    if (!this.ensureSchemaPromise) {
      this.ensureSchemaPromise = this.runEnsureSchema();
    }

    await this.ensureSchemaPromise;
  }

  async searchByEmbedding(options: DenseKnowledgeSearchOptions): Promise<RetrievalResult[]> {
    await this.ensureSchema();

    assertQueryEmbedding(options.queryEmbedding);
    assertRequiredRetrievalFilter(options.filter, 'searchByEmbedding');

    const vectorLiteral = toVectorLiteral(options.queryEmbedding);
    const similarityExpression = buildDenseSimilarityExpression('p.distance_metric', '$1');
    const values: unknown[] = [vectorLiteral];
    const filterSql = buildPostgresFilterClause(options.filter, values, 'c', 's');
    const minScoreSql =
      options.minScore !== undefined
        ? ` AND ${similarityExpression} >= ${pushSqlValue(values, options.minScore)}`
        : '';
    const limitRef = pushSqlValue(values, Math.max(options.limit, 1));

    const pool = await this.getPool();
    const result = await pool.query<PostgresKnowledgeSearchRow>(
      `SELECT
         c.id AS chunk_id,
         c.source_id,
         c.chunk_text,
         c.citation,
         c.metadata,
         COALESCE(c.source_name, s.name) AS source_name,
         COALESCE(c.title, s.title, s.name) AS title,
         COALESCE(c.url, s.canonical_url) AS url,
         c.start_offset,
         c.end_offset,
         ${similarityExpression} AS score
       FROM ${this.qualifiedTableName('chunks')} c
       INNER JOIN ${this.qualifiedTableName('sources')} s
         ON s.id = c.source_id
        AND s.tenant_id = c.tenant_id
       INNER JOIN ${this.qualifiedTableName('profiles')} p
         ON p.id = c.embedding_profile_id
        AND p.tenant_id = c.tenant_id
       WHERE s.status = 'ready'
         AND ${filterSql.sql}
         ${minScoreSql}
       ORDER BY ${similarityExpression} DESC
       LIMIT ${limitRef}`,
      values,
    );

    return result.rows.map((row) => mapPostgresRetrievalResult(row, 'dense'));
  }

  async searchByText(options: LexicalKnowledgeSearchOptions): Promise<RetrievalResult[]> {
    await this.ensureSchema();

    const normalizedQuery = options.query.trim();
    if (normalizedQuery.length === 0) {
      return [];
    }

    assertRequiredRetrievalFilter(options.filter, 'searchByText');

    const values: unknown[] = [normalizedQuery];
    const queryExpression = buildTsQueryExpression(this.searchConfig, '$1');
    const rankExpression = `ts_rank_cd(c.search_document, ${queryExpression})`;
    const filterSql = buildPostgresFilterClause(options.filter, values, 'c', 's');
    const minScoreSql =
      options.minScore !== undefined
        ? ` AND ${rankExpression} >= ${pushSqlValue(values, options.minScore)}`
        : '';
    const limitRef = pushSqlValue(values, Math.max(options.limit, 1));

    const pool = await this.getPool();
    const result = await pool.query<PostgresKnowledgeSearchRow>(
      `SELECT
         c.id AS chunk_id,
         c.source_id,
         c.chunk_text,
         c.citation,
         c.metadata,
         COALESCE(c.source_name, s.name) AS source_name,
         COALESCE(c.title, s.title, s.name) AS title,
         COALESCE(c.url, s.canonical_url) AS url,
         c.start_offset,
         c.end_offset,
         ${rankExpression} AS score
       FROM ${this.qualifiedTableName('chunks')} c
       INNER JOIN ${this.qualifiedTableName('sources')} s
         ON s.id = c.source_id
        AND s.tenant_id = c.tenant_id
       WHERE s.status = 'ready'
         AND c.search_document @@ ${queryExpression}
         AND ${filterSql.sql}
         ${minScoreSql}
       ORDER BY ${rankExpression} DESC
       LIMIT ${limitRef}`,
      values,
    );

    return result.rows.map((row) => mapPostgresRetrievalResult(row, 'lexical'));
  }

  async activateEmbeddingProfile(
    options: PostgresActivateEmbeddingProfileOptions,
  ): Promise<void> {
    await this.ensureSchema();

    const timestamp = this.now().toISOString();
    const pool = await this.getPool();
    await pool.query(
      `UPDATE ${this.qualifiedTableName('spaces')}
       SET active_embedding_profile_id = $1,
           updated_at = $2
       WHERE id = $3
         AND tenant_id = $4
         AND bot_id = $5`,
      [
        options.embeddingProfileId,
        timestamp,
        options.knowledgeSpaceId,
        options.tenantId,
        options.botId,
      ],
    );
  }

  async getActiveEmbeddingProfile(
    filter: PostgresActiveEmbeddingProfileFilter,
  ): Promise<PostgresEmbeddingProfileRecord | null> {
    await this.ensureSchema();

    const pool = await this.getPool();
    const result = await pool.query<PostgresEmbeddingProfileRow>(
      `SELECT
         p.id,
         p.knowledge_space_id,
         p.tenant_id,
         p.bot_id,
         p.provider,
         p.model,
         p.dimensions,
         p.distance_metric,
         p.purpose_defaults,
         p.task_instruction,
         p.status,
         p.created_at,
         p.updated_at
       FROM ${this.qualifiedTableName('spaces')} s
       INNER JOIN ${this.qualifiedTableName('profiles')} p
         ON p.id = s.active_embedding_profile_id
        AND p.tenant_id = s.tenant_id
       WHERE s.id = $1
         AND s.tenant_id = $2
         AND s.bot_id = $3
       LIMIT 1`,
      [filter.knowledgeSpaceId, filter.tenantId, filter.botId],
    );

    const row = result.rows[0];
    return row ? mapPostgresEmbeddingProfile(row) : null;
  }

  async listKnowledgeSources(
    options: PostgresKnowledgeSourceListOptions,
  ): Promise<PostgresKnowledgeSourceRecord[]> {
    await this.ensureSchema();

    const values: unknown[] = [];
    const clauses = [
      `tenant_id = ${pushSqlValue(values, options.tenantId)}`,
      `bot_id = ${pushSqlValue(values, options.botId)}`,
      `knowledge_space_id = ${pushSqlValue(values, options.knowledgeSpaceId)}`,
    ];

    if (options.embeddingProfileId) {
      clauses.push(
        `embedding_profile_id = ${pushSqlValue(values, options.embeddingProfileId)}`,
      );
    }

    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status = ANY(${pushSqlValue(values, options.statuses)})`);
    }

    const limitRef = pushSqlValue(values, Math.max(options.limit ?? 100, 1));
    const pool = await this.getPool();
    const result = await pool.query<PostgresKnowledgeSourceRow>(
      `SELECT
         id,
         knowledge_space_id,
         tenant_id,
         bot_id,
         embedding_profile_id,
         source_type,
         external_id,
         name,
         title,
         canonical_url,
         checksum,
         status,
         progress_percent,
         error_message,
         metadata,
         created_at,
         updated_at
       FROM ${this.qualifiedTableName('sources')}
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ${limitRef}`,
      values,
    );

    return result.rows.map(mapPostgresKnowledgeSource);
  }

  async markKnowledgeSourcesNeedingReindex(
    options: PostgresMarkKnowledgeSourcesNeedingReindexOptions,
  ): Promise<number> {
    await this.ensureSchema();

    const timestamp = this.now().toISOString();
    const values: unknown[] = [
      options.toEmbeddingProfileId,
      timestamp,
      options.tenantId,
      options.botId,
      options.knowledgeSpaceId,
    ];
    let where = `tenant_id = $3
         AND bot_id = $4
         AND knowledge_space_id = $5
         AND (embedding_profile_id IS NULL OR embedding_profile_id <> $1)`;

    if (options.fromEmbeddingProfileId) {
      values.push(options.fromEmbeddingProfileId);
      where += ` AND embedding_profile_id = $6`;
    }

    const pool = await this.getPool();
    const result = await pool.query(
      `UPDATE ${this.qualifiedTableName('sources')}
       SET status = 'needs_reindex',
           updated_at = $2
       WHERE ${where}`,
      values,
    );

    return result.rowCount ?? 0;
  }

  async upsertEmbeddingProfile(
    record: PostgresEmbeddingProfileRecord,
  ): Promise<PostgresEmbeddingProfileRecord> {
    await this.ensureSchema();
    await this.assertEmbeddingProfileImmutability(record);

    const timestamp = this.now().toISOString();
    const createdAt = record.createdAt ?? timestamp;
    const updatedAt = record.updatedAt ?? timestamp;
    const values: unknown[] = [
      record.id,
      record.knowledgeSpaceId,
      record.tenantId,
      record.botId,
      record.provider,
      record.model,
      record.dimensions,
      record.distanceMetric ?? 'cosine',
      JSON.stringify(record.purposeDefaults ?? []),
      record.taskInstruction ?? null,
      record.status ?? 'active',
      createdAt,
      updatedAt,
    ];

    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.qualifiedTableName('profiles')} (
         id,
         knowledge_space_id,
         tenant_id,
         bot_id,
         provider,
         model,
         dimensions,
         distance_metric,
         purpose_defaults,
         task_instruction,
         status,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13
       )
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      values,
    );

    return {
      ...record,
      createdAt,
      updatedAt,
      ...(record.distanceMetric === undefined ? { distanceMetric: 'cosine' } : {}),
      ...(record.purposeDefaults === undefined ? { purposeDefaults: [] } : {}),
      ...(record.status === undefined ? { status: 'active' } : {}),
    };
  }

  async upsertKnowledgeChunk(
    record: PostgresKnowledgeChunkRecord,
  ): Promise<PostgresKnowledgeChunkRecord> {
    await this.ensureSchema();

    assertQueryEmbedding(record.embedding);

    const timestamp = this.now().toISOString();
    const createdAt = record.createdAt ?? timestamp;
    const updatedAt = record.updatedAt ?? timestamp;
    const values: unknown[] = [
      record.id,
      record.knowledgeSpaceId,
      record.tenantId,
      record.botId,
      record.sourceId,
      record.embeddingProfileId,
      record.chunkIndex,
      record.text,
      JSON.stringify(serializeCitation(record.citation, record)),
      JSON.stringify(record.metadata ?? {}),
      toVectorLiteral(record.embedding),
      record.tokenCount ?? null,
      record.sourceType ?? null,
      record.sourceName ?? null,
      record.title ?? null,
      record.url ?? null,
      record.scopeType ?? 'bot',
      record.scopeUserId ?? null,
      record.startOffset ?? null,
      record.endOffset ?? null,
      createdAt,
      updatedAt,
    ];

    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.qualifiedTableName('chunks')} (
         id,
         knowledge_space_id,
         tenant_id,
         bot_id,
         source_id,
         embedding_profile_id,
         chunk_index,
         chunk_text,
         citation,
         metadata,
         embedding,
         token_count,
         source_type,
         source_name,
         title,
         url,
         scope_type,
         scope_user_id,
         start_offset,
         end_offset,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::vector, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
       )
       ON CONFLICT (id) DO UPDATE SET
         knowledge_space_id = EXCLUDED.knowledge_space_id,
         tenant_id = EXCLUDED.tenant_id,
         bot_id = EXCLUDED.bot_id,
         source_id = EXCLUDED.source_id,
         embedding_profile_id = EXCLUDED.embedding_profile_id,
         chunk_index = EXCLUDED.chunk_index,
         chunk_text = EXCLUDED.chunk_text,
         citation = EXCLUDED.citation,
         metadata = EXCLUDED.metadata,
         embedding = EXCLUDED.embedding,
         token_count = EXCLUDED.token_count,
         source_type = EXCLUDED.source_type,
         source_name = EXCLUDED.source_name,
         title = EXCLUDED.title,
         url = EXCLUDED.url,
         scope_type = EXCLUDED.scope_type,
         scope_user_id = EXCLUDED.scope_user_id,
         start_offset = EXCLUDED.start_offset,
         end_offset = EXCLUDED.end_offset,
         updated_at = EXCLUDED.updated_at`,
      values,
    );

    return {
      ...record,
      createdAt,
      updatedAt,
      ...(record.scopeType === undefined ? { scopeType: 'bot' } : {}),
    };
  }

  async upsertKnowledgeSource(
    record: PostgresKnowledgeSourceRecord,
  ): Promise<PostgresKnowledgeSourceRecord> {
    await this.ensureSchema();

    const timestamp = this.now().toISOString();
    const createdAt = record.createdAt ?? timestamp;
    const updatedAt = record.updatedAt ?? timestamp;
    const values: unknown[] = [
      record.id,
      record.knowledgeSpaceId,
      record.tenantId,
      record.botId,
      record.embeddingProfileId ?? null,
      record.sourceType,
      record.externalId ?? null,
      record.name,
      record.title ?? null,
      record.canonicalUrl ?? null,
      record.checksum ?? null,
      record.status ?? 'queued',
      record.progressPercent ?? 0,
      record.errorMessage ?? null,
      JSON.stringify(record.metadata ?? {}),
      createdAt,
      updatedAt,
    ];

    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.qualifiedTableName('sources')} (
         id,
         knowledge_space_id,
         tenant_id,
         bot_id,
         embedding_profile_id,
         source_type,
         external_id,
         name,
         title,
         canonical_url,
         checksum,
         status,
         progress_percent,
         error_message,
         metadata,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17
       )
       ON CONFLICT (id) DO UPDATE SET
         knowledge_space_id = EXCLUDED.knowledge_space_id,
         tenant_id = EXCLUDED.tenant_id,
         bot_id = EXCLUDED.bot_id,
         embedding_profile_id = EXCLUDED.embedding_profile_id,
         source_type = EXCLUDED.source_type,
         external_id = EXCLUDED.external_id,
         name = EXCLUDED.name,
         title = EXCLUDED.title,
         canonical_url = EXCLUDED.canonical_url,
         checksum = EXCLUDED.checksum,
         status = EXCLUDED.status,
         progress_percent = EXCLUDED.progress_percent,
         error_message = EXCLUDED.error_message,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`,
      values,
    );

    return {
      ...record,
      createdAt,
      updatedAt,
      ...(record.progressPercent === undefined ? { progressPercent: 0 } : {}),
      ...(record.status === undefined ? { status: 'queued' } : {}),
    };
  }

  async upsertKnowledgeSpace(
    record: PostgresKnowledgeSpaceRecord,
  ): Promise<PostgresKnowledgeSpaceRecord> {
    await this.ensureSchema();

    const timestamp = this.now().toISOString();
    const createdAt = record.createdAt ?? timestamp;
    const updatedAt = record.updatedAt ?? timestamp;
    const values: unknown[] = [
      record.id,
      record.tenantId,
      record.botId,
      record.name,
      record.visibilityScope ?? 'bot',
      record.activeEmbeddingProfileId ?? null,
      JSON.stringify(record.metadata ?? {}),
      createdAt,
      updatedAt,
    ];

    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO ${this.qualifiedTableName('spaces')} (
         id,
         tenant_id,
         bot_id,
         name,
         visibility_scope,
         active_embedding_profile_id,
         metadata,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
       )
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         bot_id = EXCLUDED.bot_id,
         name = EXCLUDED.name,
         visibility_scope = EXCLUDED.visibility_scope,
         active_embedding_profile_id = EXCLUDED.active_embedding_profile_id,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`,
      values,
    );

    return {
      ...record,
      createdAt,
      updatedAt,
      ...(record.visibilityScope === undefined ? { visibilityScope: 'bot' } : {}),
    };
  }

  private async assertEmbeddingProfileImmutability(
    record: PostgresEmbeddingProfileRecord,
  ): Promise<void> {
    const pool = await this.getPool();
    const result = await pool.query<PostgresEmbeddingProfileRow>(
      `SELECT
         id,
         knowledge_space_id,
         tenant_id,
         bot_id,
         provider,
         model,
         dimensions,
         distance_metric,
         purpose_defaults,
         task_instruction,
         status,
         created_at,
         updated_at
       FROM ${this.qualifiedTableName('profiles')}
       WHERE id = $1
       LIMIT 1`,
      [record.id],
    );
    const existing = result.rows[0];

    if (!existing) {
      return;
    }

    const immutableChanges: string[] = [];
    if (existing.knowledge_space_id !== record.knowledgeSpaceId) {
      immutableChanges.push('knowledgeSpaceId');
    }
    if (existing.tenant_id !== record.tenantId) {
      immutableChanges.push('tenantId');
    }
    if (existing.bot_id !== record.botId) {
      immutableChanges.push('botId');
    }
    if (existing.provider !== record.provider) {
      immutableChanges.push('provider');
    }
    if (existing.model !== record.model) {
      immutableChanges.push('model');
    }
    if (existing.dimensions !== record.dimensions) {
      immutableChanges.push('dimensions');
    }
    if ((existing.distance_metric ?? 'cosine') !== (record.distanceMetric ?? 'cosine')) {
      immutableChanges.push('distanceMetric');
    }
    if ((existing.task_instruction ?? null) !== (record.taskInstruction ?? null)) {
      immutableChanges.push('taskInstruction');
    }

    const existingPurposes = JSON.stringify(normalizePurposeDefaults(existing.purpose_defaults));
    const incomingPurposes = JSON.stringify(record.purposeDefaults ?? []);
    if (existingPurposes !== incomingPurposes) {
      immutableChanges.push('purposeDefaults');
    }

    if (immutableChanges.length > 0) {
      throw new LLMError(
        `Embedding profiles are immutable. Create a new profile id instead of changing: ${immutableChanges.join(', ')}.`,
      );
    }
  }

  private qualifiedTableName(
    tableName: keyof Required<PostgresKnowledgeStoreTableNames>,
  ): string {
    return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(this.tableNames[tableName])}`;
  }

  private async getPool(): Promise<PostgresKnowledgeStorePool> {
    if (this.pool) {
      return this.pool;
    }

    if (this.internalPool) {
      return this.internalPool;
    }

    const connectionString = this.connectionString ?? getEnvironmentVariable('DATABASE_URL');
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is required for PostgresKnowledgeStore. Set it in .env or pass connectionString explicitly.',
      );
    }

    const Pool = await loadPgPoolConstructor();
    const pool = new Pool({
      connectionString,
    });
    this.internalPool = pool;
    return pool;
  }

  private async runEnsureSchema(): Promise<void> {
    const pool = await this.getPool();
    const spacesTable = this.qualifiedTableName('spaces');
    const profilesTable = this.qualifiedTableName('profiles');
    const sourcesTable = this.qualifiedTableName('sources');
    const chunksTable = this.qualifiedTableName('chunks');

    if (this.ensureVectorExtension) {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    }

    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${spacesTable} (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL,
         bot_id TEXT NOT NULL,
         name TEXT NOT NULL,
         visibility_scope TEXT NOT NULL DEFAULT 'bot',
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL
       )`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${profilesTable} (
         id TEXT PRIMARY KEY,
         knowledge_space_id TEXT NOT NULL REFERENCES ${spacesTable}(id) ON DELETE CASCADE,
         tenant_id TEXT NOT NULL,
         bot_id TEXT NOT NULL,
         provider TEXT NOT NULL,
         model TEXT NOT NULL,
         dimensions INTEGER NOT NULL,
         distance_metric TEXT NOT NULL DEFAULT 'cosine',
         purpose_defaults JSONB NOT NULL DEFAULT '[]'::jsonb,
         task_instruction TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         created_at TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL
       )`,
    );
    await pool.query(
      `ALTER TABLE ${spacesTable}
       ADD COLUMN IF NOT EXISTS active_embedding_profile_id TEXT REFERENCES ${profilesTable}(id) ON DELETE SET NULL`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${sourcesTable} (
         id TEXT PRIMARY KEY,
         knowledge_space_id TEXT NOT NULL REFERENCES ${spacesTable}(id) ON DELETE CASCADE,
         tenant_id TEXT NOT NULL,
         bot_id TEXT NOT NULL,
         embedding_profile_id TEXT REFERENCES ${profilesTable}(id) ON DELETE SET NULL,
         source_type TEXT NOT NULL,
         external_id TEXT,
         name TEXT NOT NULL,
         title TEXT,
         canonical_url TEXT,
         checksum TEXT,
         status TEXT NOT NULL DEFAULT 'queued',
         progress_percent INTEGER NOT NULL DEFAULT 0,
         error_message TEXT,
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL
       )`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${chunksTable} (
         id TEXT PRIMARY KEY,
         knowledge_space_id TEXT NOT NULL REFERENCES ${spacesTable}(id) ON DELETE CASCADE,
         tenant_id TEXT NOT NULL,
         bot_id TEXT NOT NULL,
         source_id TEXT NOT NULL REFERENCES ${sourcesTable}(id) ON DELETE CASCADE,
         embedding_profile_id TEXT NOT NULL REFERENCES ${profilesTable}(id) ON DELETE CASCADE,
         chunk_index INTEGER NOT NULL,
         chunk_text TEXT NOT NULL,
         citation JSONB NOT NULL DEFAULT '{}'::jsonb,
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
         search_document TSVECTOR GENERATED ALWAYS AS (
           to_tsvector(${quoteLiteral(this.searchConfig)}, coalesce(title, '') || ' ' || chunk_text)
         ) STORED,
         embedding VECTOR NOT NULL,
         token_count INTEGER,
         source_type TEXT,
         source_name TEXT,
         title TEXT,
         url TEXT,
         scope_type TEXT NOT NULL DEFAULT 'bot',
         scope_user_id TEXT,
         start_offset INTEGER,
         end_offset INTEGER,
         created_at TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL
       )`,
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.spaces}_tenant_bot_idx`)}
       ON ${spacesTable} (tenant_id, bot_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.spaces}_active_profile_idx`)}
       ON ${spacesTable} (active_embedding_profile_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.profiles}_tenant_bot_status_idx`)}
       ON ${profilesTable} (tenant_id, bot_id, knowledge_space_id, status)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.sources}_tenant_bot_status_idx`)}
       ON ${sourcesTable} (tenant_id, bot_id, knowledge_space_id, status, updated_at DESC)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.sources}_embedding_profile_idx`)}
       ON ${sourcesTable} (embedding_profile_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_tenant_profile_idx`)}
       ON ${chunksTable} (tenant_id, bot_id, knowledge_space_id, embedding_profile_id, chunk_index)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_source_idx`)}
       ON ${chunksTable} (source_id, chunk_index)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_scope_idx`)}
       ON ${chunksTable} (scope_type, scope_user_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_search_document_idx`)}
       ON ${chunksTable} USING GIN (search_document)`,
    );
  }
}

function assertQueryEmbedding(queryEmbedding: number[]): void {
  if (queryEmbedding.length === 0) {
    throw new LLMError('Embedding vector is required for dense retrieval.');
  }

  for (const value of queryEmbedding) {
    if (!Number.isFinite(value)) {
      throw new LLMError('Embedding vectors must contain only finite numeric values.');
    }
  }
}

function assertRequiredRetrievalFilter(
  filter: RetrievalFilter | undefined,
  operation: 'searchByEmbedding' | 'searchByText',
): asserts filter is RetrievalFilter & {
  botId: string;
  embeddingProfileId: string;
  knowledgeSpaceId: string;
  tenantId: string;
} {
  const missing: string[] = [];

  if (!filter?.tenantId) {
    missing.push('tenantId');
  }

  if (!filter?.botId) {
    missing.push('botId');
  }

  if (!filter?.knowledgeSpaceId) {
    missing.push('knowledgeSpaceId');
  }

  if (!filter?.embeddingProfileId) {
    missing.push('embeddingProfileId');
  }

  if (missing.length > 0) {
    throw new LLMError(
      `PostgresKnowledgeStore.${operation} requires strict retrieval filters: ${missing.join(', ')}.`,
    );
  }
}

function buildDenseSimilarityExpression(
  distanceMetricSql: string,
  vectorReference: string,
): string {
  return `CASE
    WHEN ${distanceMetricSql} = 'inner_product' THEN (c.embedding <#> CAST(${vectorReference} AS vector)) * -1
    WHEN ${distanceMetricSql} = 'l2' THEN 1 / (1 + (c.embedding <-> CAST(${vectorReference} AS vector)))
    ELSE 1 - (c.embedding <=> CAST(${vectorReference} AS vector))
  END`;
}

function buildPostgresFilterClause(
  filter: RetrievalFilter,
  values: unknown[],
  chunkAlias: string,
  sourceAlias: string,
): { sql: string } {
  const clauses = [
    `${chunkAlias}.tenant_id = ${pushSqlValue(values, filter.tenantId)}`,
    `${chunkAlias}.bot_id = ${pushSqlValue(values, filter.botId)}`,
    `${chunkAlias}.knowledge_space_id = ${pushSqlValue(values, filter.knowledgeSpaceId)}`,
    `${chunkAlias}.embedding_profile_id = ${pushSqlValue(values, filter.embeddingProfileId)}`,
  ];

  if (filter.locale) {
    clauses.push(
      `COALESCE(${chunkAlias}.metadata ->> 'locale', ${sourceAlias}.metadata ->> 'locale') = ${pushSqlValue(values, filter.locale)}`,
    );
  }

  if (filter.metadata) {
    clauses.push(`${chunkAlias}.metadata @> ${pushSqlValue(values, JSON.stringify(filter.metadata))}::jsonb`);
  }

  if (filter.scopeType) {
    clauses.push(`${chunkAlias}.scope_type = ${pushSqlValue(values, filter.scopeType)}`);
  }

  if (filter.scopeUserId) {
    clauses.push(`${chunkAlias}.scope_user_id = ${pushSqlValue(values, filter.scopeUserId)}`);
  }

  if (filter.sourceIds && filter.sourceIds.length > 0) {
    clauses.push(`${chunkAlias}.source_id = ANY(${pushSqlValue(values, filter.sourceIds)})`);
  }

  if (filter.sourceTypes && filter.sourceTypes.length > 0) {
    clauses.push(
      `COALESCE(${chunkAlias}.source_type, ${sourceAlias}.source_type) = ANY(${pushSqlValue(values, filter.sourceTypes)})`,
    );
  }

  return {
    sql: clauses.join(' AND '),
  };
}

function buildSafeIndexName(value: string): string {
  return value
    .replaceAll(/[^a-zA-Z0-9_]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 63);
}

function buildTsQueryExpression(searchConfig: string, queryReference: string): string {
  return `websearch_to_tsquery(${quoteLiteral(searchConfig)}, ${queryReference})`;
}

function getPgvectorOperatorClass(distanceMetric: PostgresDistanceMetric): string {
  switch (distanceMetric) {
    case 'inner_product':
      return 'vector_ip_ops';
    case 'l2':
      return 'vector_l2_ops';
    case 'cosine':
    default:
      return 'vector_cosine_ops';
  }
}

function mapPostgresRetrievalResult(
  row: PostgresKnowledgeSearchRow,
  strategy: 'dense' | 'lexical',
): RetrievalResult {
  const score = Number(row.score);
  const result: RetrievalResult = {
    chunkId: row.chunk_id,
    raw: row,
    score,
    sourceId: row.source_id,
    text: row.chunk_text,
  };

  if (strategy === 'dense') {
    result.denseScore = score;
  } else {
    result.lexicalScore = score;
  }

  const metadata = isJsonRecord(row.metadata) ? row.metadata : undefined;
  if (metadata && Object.keys(metadata).length > 0) {
    result.metadata = metadata;
  }

  if (row.source_name) {
    result.sourceName = row.source_name;
  }

  if (row.title) {
    result.title = row.title;
  }

  if (row.url) {
    result.url = row.url;
  }

  if (row.start_offset !== null) {
    result.startOffset = row.start_offset;
  }

  if (row.end_offset !== null) {
    result.endOffset = row.end_offset;
  }

  const citation = parseStoredCitation(row.citation, result);
  if (citation) {
    result.citation = citation;
  }

  return result;
}

function mapPostgresEmbeddingProfile(
  row: PostgresEmbeddingProfileRow,
): PostgresEmbeddingProfileRecord {
  return {
    botId: row.bot_id,
    createdAt: row.created_at,
    dimensions: row.dimensions,
    distanceMetric: row.distance_metric,
    id: row.id,
    knowledgeSpaceId: row.knowledge_space_id,
    model: row.model,
    provider: row.provider,
    purposeDefaults: normalizePurposeDefaults(row.purpose_defaults),
    ...(row.task_instruction ? { taskInstruction: row.task_instruction } : {}),
    status: row.status,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  };
}

function mapPostgresKnowledgeSource(
  row: PostgresKnowledgeSourceRow,
): PostgresKnowledgeSourceRecord {
  return {
    botId: row.bot_id,
    ...(row.canonical_url ? { canonicalUrl: row.canonical_url } : {}),
    ...(row.checksum ? { checksum: row.checksum } : {}),
    createdAt: row.created_at,
    ...(row.embedding_profile_id ? { embeddingProfileId: row.embedding_profile_id } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    id: row.id,
    knowledgeSpaceId: row.knowledge_space_id,
    metadata: isJsonRecord(row.metadata) ? row.metadata : {},
    name: row.name,
    progressPercent: row.progress_percent,
    sourceType: row.source_type,
    status: row.status,
    tenantId: row.tenant_id,
    ...(row.title ? { title: row.title } : {}),
    updatedAt: row.updated_at,
  };
}

function normalizePurposeDefaults(value: JsonValue): EmbeddingPurpose[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isEmbeddingPurpose);
}

function isEmbeddingPurpose(value: JsonValue): value is EmbeddingPurpose {
  return (
    value === 'classification' ||
    value === 'clustering' ||
    value === 'retrieval_document' ||
    value === 'retrieval_query' ||
    value === 'semantic_similarity'
  );
}

function parseStoredCitation(
  value: null | Record<string, unknown>,
  result: RetrievalResult,
): RetrievalCitation | undefined {
  if (!value || Array.isArray(value)) {
    return buildCitation(result);
  }

  const citation: RetrievalCitation = {
    chunkId: result.chunkId,
    sourceId: result.sourceId,
  };

  const endOffset = value.endOffset;
  if (typeof endOffset === 'number') {
    citation.endOffset = endOffset;
  }

  const metadata = value.metadata;
  if (isJsonRecord(metadata)) {
    citation.metadata = metadata;
  }

  const ordinal = value.ordinal;
  if (typeof ordinal === 'number') {
    citation.ordinal = ordinal;
  }

  const sourceName = value.sourceName;
  if (typeof sourceName === 'string') {
    citation.sourceName = sourceName;
  } else if (result.sourceName) {
    citation.sourceName = result.sourceName;
  }

  const startOffset = value.startOffset;
  if (typeof startOffset === 'number') {
    citation.startOffset = startOffset;
  }

  const title = value.title;
  if (typeof title === 'string') {
    citation.title = title;
  } else if (result.title) {
    citation.title = result.title;
  }

  const url = value.url;
  if (typeof url === 'string') {
    citation.url = url;
  } else if (result.url) {
    citation.url = result.url;
  }

  return citation;
}

function pushSqlValue(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function serializeCitation(
  citation: PostgresKnowledgeChunkRecord['citation'],
  record: PostgresKnowledgeChunkRecord,
): Record<string, JsonValue> {
  if (!citation) {
    return {
      chunkId: record.id,
      sourceId: record.sourceId,
      ...(record.endOffset !== undefined ? { endOffset: record.endOffset } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      ...(record.sourceName ? { sourceName: record.sourceName } : {}),
      ...(record.startOffset !== undefined ? { startOffset: record.startOffset } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(record.url ? { url: record.url } : {}),
    };
  }

  return {
    chunkId: citation.chunkId,
    sourceId: citation.sourceId,
    ...(citation.endOffset !== undefined ? { endOffset: citation.endOffset } : {}),
    ...(citation.metadata ? { metadata: citation.metadata } : {}),
    ...(citation.ordinal !== undefined ? { ordinal: citation.ordinal } : {}),
    ...(citation.sourceName ? { sourceName: citation.sourceName } : {}),
    ...(citation.startOffset !== undefined ? { startOffset: citation.startOffset } : {}),
    ...(citation.title ? { title: citation.title } : {}),
    ...(citation.url ? { url: citation.url } : {}),
  };
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((value) => Number(value).toString()).join(',')}]`;
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
