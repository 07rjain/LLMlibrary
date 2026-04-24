import { LLMError } from './errors.js';
import { loadPgPoolConstructor } from './node-pg-loader.js';
import { getEnvironmentVariable } from './runtime.js';
import { estimateTokens } from './utils/token-estimator.js';
const DEFAULT_RETRIEVAL_TOP_K = 8;
const DEFAULT_FUSION_K = 60;
const TRUNCATION_MARKER = '\n[truncated]';
export function createDenseRetriever(options) {
    const embed = resolveEmbedFunction(options.embed);
    const defaultTopK = Math.max(options.defaultTopK ?? DEFAULT_RETRIEVAL_TOP_K, 1);
    return {
        async search(query) {
            const embeddingResponse = await embed(buildEmbeddingRequestOptions(options.embedding, query));
            const embedding = embeddingResponse.embeddings[0]?.values;
            if (!embedding) {
                throw new LLMError('Embedding response did not contain any vectors.', {
                    model: embeddingResponse.model,
                    provider: embeddingResponse.provider,
                });
            }
            const results = await options.store.searchByEmbedding(buildDenseSearchOptions(query.filter, Math.max(query.topK ?? defaultTopK, 1), query.minScore ?? options.defaultMinScore, embedding));
            return limitRetrievalResults(results, buildLimitOptions(query.maxPerSource, query.topK ?? defaultTopK));
        },
    };
}
export function createHybridRetriever(options) {
    const embed = resolveEmbedFunction(options.embed);
    const defaultTopK = Math.max(options.defaultTopK ?? DEFAULT_RETRIEVAL_TOP_K, 1);
    const denseLimitDefault = Math.max(options.defaultDenseK ?? defaultTopK, 1);
    const lexicalLimitDefault = Math.max(options.defaultLexicalK ?? defaultTopK, 1);
    return {
        async search(query) {
            if (!options.store.searchByText) {
                throw new LLMError('Hybrid retrieval requires knowledgeStore.searchByText() support.');
            }
            const embeddingResponse = await embed(buildEmbeddingRequestOptions(options.embedding, query));
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
                options.store.searchByEmbedding(buildDenseSearchOptions(query.filter, denseLimit, query.minScore ?? options.defaultMinScore, embedding)),
                options.store.searchByText(buildLexicalSearchOptions(query.filter, lexicalLimit, query.minScore ?? options.defaultMinScore, query.query)),
            ]);
            return mergeRetrievalCandidates({
                denseResults,
                lexicalResults,
                topK: requestedTopK,
                ...buildHybridMergeOptions(options.denseWeight, options.fusionK, options.lexicalWeight, query.maxPerSource),
            });
        },
    };
}
export function mergeRetrievalCandidates(options) {
    const fusionK = options.fusionK ?? DEFAULT_FUSION_K;
    const denseWeight = options.denseWeight ?? 1;
    const lexicalWeight = options.lexicalWeight ?? 1;
    const merged = new Map();
    applyReciprocalRankFusion(merged, options.denseResults ?? [], denseWeight, fusionK, 'dense');
    applyReciprocalRankFusion(merged, options.lexicalResults ?? [], lexicalWeight, fusionK, 'lexical');
    const ranked = Array.from(merged.values())
        .sort((left, right) => right.fusionScore - left.fusionScore)
        .map((entry, index) => {
        const result = {
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
    return limitRetrievalResults(ranked, buildLimitOptions(options.maxPerSource, options.topK));
}
export function formatRetrievedContext(results, options = {}) {
    const limited = limitRetrievalResults(results, buildLimitOptions(options.maxPerSource, options.maxResults));
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
    const headerPrefix = `${header}\n\n`;
    const blocks = [];
    const usedResults = [];
    const citations = [];
    let estimatedTokens = estimateTokens(headerPrefix);
    let truncated = false;
    for (const [index, result] of limited.entries()) {
        const ordinal = index + 1;
        const prefix = buildContextBlockPrefix(result, ordinal, includeScores, includeMetadataKeys);
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
        const minimumFallbackTextTokens = Math.max(remainingTokens - estimateTokens(TRUNCATION_MARKER), 0);
        if (availableTextTokens <= 0) {
            if (usedResults.length > 0 || minimumFallbackTextTokens <= 0) {
                truncated = true;
                break;
            }
            const fallbackPrefix = `[${ordinal}] Source: ${formatSourceLabel(result)}\n`;
            const fallbackPrefixTokens = estimateTokens(fallbackPrefix);
            const fallbackAvailableTextTokens = remainingTokens -
                fallbackPrefixTokens -
                estimateTokens(TRUNCATION_MARKER);
            if (fallbackAvailableTextTokens <= 0) {
                truncated = true;
                break;
            }
            const fallbackText = truncateTextToTokenBudget(result.text.trim(), fallbackAvailableTextTokens);
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
function applyReciprocalRankFusion(merged, results, weight, fusionK, strategy) {
    for (const [index, result] of results.entries()) {
        const key = getRetrievalResultKey(result);
        const existing = merged.get(key);
        const fusionScore = weight / (fusionK + index + 1);
        if (!existing) {
            const entry = {
                fusionScore,
                result: result.citation ? result : { ...result, citation: buildCitation(result) },
            };
            if (strategy === 'dense') {
                entry.denseScore = result.score;
            }
            else {
                entry.lexicalScore = result.score;
            }
            merged.set(key, entry);
            continue;
        }
        existing.fusionScore += fusionScore;
        existing.result = mergeRetrievalResultDetails(existing.result, result);
        if (strategy === 'dense') {
            existing.denseScore = result.score;
        }
        else {
            existing.lexicalScore = result.score;
        }
    }
}
function buildCitation(result) {
    if (result.citation) {
        return result.citation;
    }
    const citation = {
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
function buildContextBlockPrefix(result, ordinal, includeScores, includeMetadataKeys) {
    const lines = [`[${ordinal}] Source: ${formatSourceLabel(result)}`];
    if (includeScores) {
        lines.push(`Score: ${result.score.toFixed(4)}`);
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
function formatMetadataValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => formatMetadataValue(item)).join(', ');
    }
    if (value && typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}
function formatSourceLabel(result) {
    return result.title ?? result.sourceName ?? result.sourceId;
}
function getRetrievalResultKey(result) {
    return `${result.sourceId}:${result.chunkId}`;
}
function limitRetrievalResults(results, options) {
    const topK = options.topK;
    const maxPerSource = options.maxPerSource;
    const sourceCounts = new Map();
    const limited = [];
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
function mergeRetrievalResultDetails(current, incoming) {
    const merged = {
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
function resolveEmbedFunction(embed) {
    if (typeof embed === 'function') {
        return embed;
    }
    return embed.embed.bind(embed);
}
function roundNumber(value) {
    return Number(value.toFixed(8));
}
function truncateTextToTokenBudget(text, tokenBudget) {
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
        }
        else {
            high = middle - 1;
        }
    }
    return best;
}
function withCitationOrdinal(result, ordinal) {
    return {
        ...result,
        citation: {
            ...buildCitation(result),
            ordinal,
        },
    };
}
function buildDenseSearchOptions(filter, limit, minScore, queryEmbedding) {
    return {
        limit,
        queryEmbedding,
        ...(filter ? { filter } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
    };
}
function buildEmbeddingRequestOptions(embeddingOptions, query) {
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
function buildHybridMergeOptions(denseWeight, fusionK, lexicalWeight, maxPerSource) {
    return {
        ...(denseWeight !== undefined ? { denseWeight } : {}),
        ...(fusionK !== undefined ? { fusionK } : {}),
        ...(lexicalWeight !== undefined ? { lexicalWeight } : {}),
        ...(maxPerSource !== undefined ? { maxPerSource } : {}),
    };
}
function buildLexicalSearchOptions(filter, limit, minScore, query) {
    return {
        limit,
        query,
        ...(filter ? { filter } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
    };
}
function buildLimitOptions(maxPerSource, topK) {
    return {
        ...(maxPerSource !== undefined ? { maxPerSource } : {}),
        ...(topK !== undefined ? { topK } : {}),
    };
}
const DEFAULT_POSTGRES_SEARCH_CONFIG = 'english';
const DEFAULT_POSTGRES_SCHEMA = 'public';
const DEFAULT_POSTGRES_TABLE_NAMES = {
    chunks: 'knowledge_chunks',
    profiles: 'embedding_profiles',
    sources: 'knowledge_sources',
    spaces: 'knowledge_spaces',
};
export function createPostgresKnowledgeStore(options = {}) {
    return new PostgresKnowledgeStore(options);
}
export function createPgvectorHnswIndexSql(options) {
    const schemaName = options.schemaName ?? DEFAULT_POSTGRES_SCHEMA;
    const chunksTableName = options.chunksTableName ?? DEFAULT_POSTGRES_TABLE_NAMES.chunks;
    const distanceMetric = options.distanceMetric ?? 'cosine';
    const opClass = getPgvectorOperatorClass(distanceMetric);
    const indexName = options.indexName ??
        buildSafeIndexName(`${chunksTableName}_${options.embeddingProfileId}_${distanceMetric}_hnsw_idx`);
    return `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)}
ON ${quoteIdentifier(schemaName)}.${quoteIdentifier(chunksTableName)}
USING hnsw ((embedding::vector(${options.dimensions})) ${opClass})
WHERE embedding_profile_id = ${quoteLiteral(options.embeddingProfileId)} AND embedding IS NOT NULL;`;
}
export class PostgresKnowledgeStore {
    connectionString;
    ensureSchemaPromise = null;
    ensureVectorExtension;
    internalPool;
    now;
    pool;
    schemaName;
    searchConfig;
    tableNames;
    constructor(options = {}) {
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
    static fromEnv(options = {}) {
        const connectionString = getEnvironmentVariable('DATABASE_URL');
        return new PostgresKnowledgeStore({
            ...options,
            ...(connectionString ? { connectionString } : {}),
        });
    }
    async close() {
        if (!this.internalPool?.end) {
            return;
        }
        await this.internalPool.end();
        this.internalPool = undefined;
        this.ensureSchemaPromise = null;
    }
    async ensureSchema() {
        if (!this.ensureSchemaPromise) {
            this.ensureSchemaPromise = this.runEnsureSchema();
        }
        await this.ensureSchemaPromise;
    }
    async searchByEmbedding(options) {
        await this.ensureSchema();
        assertQueryEmbedding(options.queryEmbedding);
        assertRequiredRetrievalFilter(options.filter, 'searchByEmbedding');
        const vectorLiteral = toVectorLiteral(options.queryEmbedding);
        const similarityExpression = buildDenseSimilarityExpression('p.distance_metric', '$1');
        const values = [vectorLiteral];
        const filterSql = buildPostgresFilterClause(options.filter, values, 'c', 's');
        const minScoreSql = options.minScore !== undefined
            ? ` AND ${similarityExpression} >= ${pushSqlValue(values, options.minScore)}`
            : '';
        const limitRef = pushSqlValue(values, Math.max(options.limit, 1));
        const pool = await this.getPool();
        const result = await pool.query(`SELECT
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
       LIMIT ${limitRef}`, values);
        return result.rows.map((row) => mapPostgresRetrievalResult(row, 'dense'));
    }
    async searchByText(options) {
        await this.ensureSchema();
        const normalizedQuery = options.query.trim();
        if (normalizedQuery.length === 0) {
            return [];
        }
        assertRequiredRetrievalFilter(options.filter, 'searchByText');
        const values = [normalizedQuery];
        const queryExpression = buildTsQueryExpression(this.searchConfig, '$1');
        const rankExpression = `ts_rank_cd(c.search_document, ${queryExpression})`;
        const filterSql = buildPostgresFilterClause(options.filter, values, 'c', 's');
        const minScoreSql = options.minScore !== undefined
            ? ` AND ${rankExpression} >= ${pushSqlValue(values, options.minScore)}`
            : '';
        const limitRef = pushSqlValue(values, Math.max(options.limit, 1));
        const pool = await this.getPool();
        const result = await pool.query(`SELECT
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
       LIMIT ${limitRef}`, values);
        return result.rows.map((row) => mapPostgresRetrievalResult(row, 'lexical'));
    }
    async upsertEmbeddingProfile(record) {
        await this.ensureSchema();
        const timestamp = this.now().toISOString();
        const createdAt = record.createdAt ?? timestamp;
        const updatedAt = record.updatedAt ?? timestamp;
        const values = [
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
        await pool.query(`INSERT INTO ${this.qualifiedTableName('profiles')} (
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
         knowledge_space_id = EXCLUDED.knowledge_space_id,
         tenant_id = EXCLUDED.tenant_id,
         bot_id = EXCLUDED.bot_id,
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         dimensions = EXCLUDED.dimensions,
         distance_metric = EXCLUDED.distance_metric,
         purpose_defaults = EXCLUDED.purpose_defaults,
         task_instruction = EXCLUDED.task_instruction,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`, values);
        return {
            ...record,
            createdAt,
            updatedAt,
            ...(record.distanceMetric === undefined ? { distanceMetric: 'cosine' } : {}),
            ...(record.purposeDefaults === undefined ? { purposeDefaults: [] } : {}),
            ...(record.status === undefined ? { status: 'active' } : {}),
        };
    }
    async upsertKnowledgeChunk(record) {
        await this.ensureSchema();
        assertQueryEmbedding(record.embedding);
        const timestamp = this.now().toISOString();
        const createdAt = record.createdAt ?? timestamp;
        const updatedAt = record.updatedAt ?? timestamp;
        const values = [
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
        await pool.query(`INSERT INTO ${this.qualifiedTableName('chunks')} (
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
         updated_at = EXCLUDED.updated_at`, values);
        return {
            ...record,
            createdAt,
            updatedAt,
            ...(record.scopeType === undefined ? { scopeType: 'bot' } : {}),
        };
    }
    async upsertKnowledgeSource(record) {
        await this.ensureSchema();
        const timestamp = this.now().toISOString();
        const createdAt = record.createdAt ?? timestamp;
        const updatedAt = record.updatedAt ?? timestamp;
        const values = [
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
        await pool.query(`INSERT INTO ${this.qualifiedTableName('sources')} (
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
         updated_at = EXCLUDED.updated_at`, values);
        return {
            ...record,
            createdAt,
            updatedAt,
            ...(record.progressPercent === undefined ? { progressPercent: 0 } : {}),
            ...(record.status === undefined ? { status: 'queued' } : {}),
        };
    }
    async upsertKnowledgeSpace(record) {
        await this.ensureSchema();
        const timestamp = this.now().toISOString();
        const createdAt = record.createdAt ?? timestamp;
        const updatedAt = record.updatedAt ?? timestamp;
        const values = [
            record.id,
            record.tenantId,
            record.botId,
            record.name,
            record.visibilityScope ?? 'bot',
            JSON.stringify(record.metadata ?? {}),
            createdAt,
            updatedAt,
        ];
        const pool = await this.getPool();
        await pool.query(`INSERT INTO ${this.qualifiedTableName('spaces')} (
         id,
         tenant_id,
         bot_id,
         name,
         visibility_scope,
         metadata,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8
       )
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         bot_id = EXCLUDED.bot_id,
         name = EXCLUDED.name,
         visibility_scope = EXCLUDED.visibility_scope,
         metadata = EXCLUDED.metadata,
         updated_at = EXCLUDED.updated_at`, values);
        return {
            ...record,
            createdAt,
            updatedAt,
            ...(record.visibilityScope === undefined ? { visibilityScope: 'bot' } : {}),
        };
    }
    qualifiedTableName(tableName) {
        return `${quoteIdentifier(this.schemaName)}.${quoteIdentifier(this.tableNames[tableName])}`;
    }
    async getPool() {
        if (this.pool) {
            return this.pool;
        }
        if (this.internalPool) {
            return this.internalPool;
        }
        const connectionString = this.connectionString ?? getEnvironmentVariable('DATABASE_URL');
        if (!connectionString) {
            throw new Error('DATABASE_URL is required for PostgresKnowledgeStore. Set it in .env or pass connectionString explicitly.');
        }
        const Pool = await loadPgPoolConstructor();
        const pool = new Pool({
            connectionString,
        });
        this.internalPool = pool;
        return pool;
    }
    async runEnsureSchema() {
        const pool = await this.getPool();
        const spacesTable = this.qualifiedTableName('spaces');
        const profilesTable = this.qualifiedTableName('profiles');
        const sourcesTable = this.qualifiedTableName('sources');
        const chunksTable = this.qualifiedTableName('chunks');
        if (this.ensureVectorExtension) {
            await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        }
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schemaName)}`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${spacesTable} (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL,
         bot_id TEXT NOT NULL,
         name TEXT NOT NULL,
         visibility_scope TEXT NOT NULL DEFAULT 'bot',
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at TIMESTAMPTZ NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL
       )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${profilesTable} (
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
       )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${sourcesTable} (
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
       )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${chunksTable} (
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
       )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.spaces}_tenant_bot_idx`)}
       ON ${spacesTable} (tenant_id, bot_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.profiles}_tenant_bot_status_idx`)}
       ON ${profilesTable} (tenant_id, bot_id, knowledge_space_id, status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.sources}_tenant_bot_status_idx`)}
       ON ${sourcesTable} (tenant_id, bot_id, knowledge_space_id, status, updated_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.sources}_embedding_profile_idx`)}
       ON ${sourcesTable} (embedding_profile_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_tenant_profile_idx`)}
       ON ${chunksTable} (tenant_id, bot_id, knowledge_space_id, embedding_profile_id, chunk_index)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_source_idx`)}
       ON ${chunksTable} (source_id, chunk_index)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_scope_idx`)}
       ON ${chunksTable} (scope_type, scope_user_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tableNames.chunks}_search_document_idx`)}
       ON ${chunksTable} USING GIN (search_document)`);
    }
}
function assertQueryEmbedding(queryEmbedding) {
    if (queryEmbedding.length === 0) {
        throw new LLMError('Embedding vector is required for dense retrieval.');
    }
    for (const value of queryEmbedding) {
        if (!Number.isFinite(value)) {
            throw new LLMError('Embedding vectors must contain only finite numeric values.');
        }
    }
}
function assertRequiredRetrievalFilter(filter, operation) {
    const missing = [];
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
        throw new LLMError(`PostgresKnowledgeStore.${operation} requires strict retrieval filters: ${missing.join(', ')}.`);
    }
}
function buildDenseSimilarityExpression(distanceMetricSql, vectorReference) {
    return `CASE
    WHEN ${distanceMetricSql} = 'inner_product' THEN (c.embedding <#> CAST(${vectorReference} AS vector)) * -1
    WHEN ${distanceMetricSql} = 'l2' THEN 1 / (1 + (c.embedding <-> CAST(${vectorReference} AS vector)))
    ELSE 1 - (c.embedding <=> CAST(${vectorReference} AS vector))
  END`;
}
function buildPostgresFilterClause(filter, values, chunkAlias, sourceAlias) {
    const clauses = [
        `${chunkAlias}.tenant_id = ${pushSqlValue(values, filter.tenantId)}`,
        `${chunkAlias}.bot_id = ${pushSqlValue(values, filter.botId)}`,
        `${chunkAlias}.knowledge_space_id = ${pushSqlValue(values, filter.knowledgeSpaceId)}`,
        `${chunkAlias}.embedding_profile_id = ${pushSqlValue(values, filter.embeddingProfileId)}`,
    ];
    if (filter.locale) {
        clauses.push(`COALESCE(${chunkAlias}.metadata ->> 'locale', ${sourceAlias}.metadata ->> 'locale') = ${pushSqlValue(values, filter.locale)}`);
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
        clauses.push(`COALESCE(${chunkAlias}.source_type, ${sourceAlias}.source_type) = ANY(${pushSqlValue(values, filter.sourceTypes)})`);
    }
    return {
        sql: clauses.join(' AND '),
    };
}
function buildSafeIndexName(value) {
    return value
        .replaceAll(/[^a-zA-Z0-9_]+/g, '_')
        .replaceAll(/^_+|_+$/g, '')
        .slice(0, 63);
}
function buildTsQueryExpression(searchConfig, queryReference) {
    return `websearch_to_tsquery(${quoteLiteral(searchConfig)}, ${queryReference})`;
}
function getPgvectorOperatorClass(distanceMetric) {
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
function mapPostgresRetrievalResult(row, strategy) {
    const score = Number(row.score);
    const result = {
        chunkId: row.chunk_id,
        raw: row,
        score,
        sourceId: row.source_id,
        text: row.chunk_text,
    };
    if (strategy === 'dense') {
        result.denseScore = score;
    }
    else {
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
function parseStoredCitation(value, result) {
    if (!value || Array.isArray(value)) {
        return buildCitation(result);
    }
    const citation = {
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
    }
    else if (result.sourceName) {
        citation.sourceName = result.sourceName;
    }
    const startOffset = value.startOffset;
    if (typeof startOffset === 'number') {
        citation.startOffset = startOffset;
    }
    const title = value.title;
    if (typeof title === 'string') {
        citation.title = title;
    }
    else if (result.title) {
        citation.title = result.title;
    }
    const url = value.url;
    if (typeof url === 'string') {
        citation.url = url;
    }
    else if (result.url) {
        citation.url = result.url;
    }
    return citation;
}
function pushSqlValue(values, value) {
    values.push(value);
    return `$${values.length}`;
}
function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function quoteLiteral(value) {
    return `'${value.replaceAll("'", "''")}'`;
}
function serializeCitation(citation, record) {
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
function toVectorLiteral(values) {
    return `[${values.map((value) => Number(value).toString()).join(',')}]`;
}
function isJsonRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
