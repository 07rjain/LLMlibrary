import type { EmbeddingInputItem, EmbeddingProvider, EmbeddingProviderOptions, EmbeddingPurpose, EmbeddingRequestOptions, EmbeddingResponse, JsonValue } from './types.js';
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
export type RetrievalRerankHook = (results: RetrievalResult[], context: RetrievalRerankContext) => Promise<RetrievalResult[]> | RetrievalResult[];
export interface EmbeddingInvoker {
    embed(options: EmbeddingRequestOptions): Promise<EmbeddingResponse>;
}
export type EmbedFunction = (options: EmbeddingRequestOptions) => Promise<EmbeddingResponse>;
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
export declare function createDenseRetriever(options: DenseRetrieverOptions): Retriever;
export declare function createHybridRetriever(options: HybridRetrieverOptions): Retriever;
export declare function mergeRetrievalCandidates(options: MergeRetrievalCandidatesOptions): RetrievalResult[];
export declare function formatRetrievedContext(results: RetrievalResult[], options?: FormatRetrievedContextOptions): FormattedRetrievedContext;
export type KnowledgeSourceStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'needs_reindex';
export type PostgresDistanceMetric = 'cosine' | 'inner_product' | 'l2';
export interface PostgresKnowledgeStoreQueryResult<TRow = Record<string, unknown>> {
    rowCount?: null | number;
    rows: TRow[];
}
export interface PostgresKnowledgeStorePool {
    end?: () => Promise<void>;
    query: <TRow = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<PostgresKnowledgeStoreQueryResult<TRow>>;
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
export interface PostgresActivateEmbeddingProfileOptions extends PostgresActiveEmbeddingProfileFilter {
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
export type MarkKnowledgeSourcesNeedingReindexOptions = PostgresMarkKnowledgeSourcesNeedingReindexOptions;
export type KnowledgeChunkRecord = PostgresKnowledgeChunkRecord;
export interface InMemoryKnowledgeStoreOptions {
    now?: () => Date;
}
export declare function createPostgresKnowledgeStore(options?: PostgresKnowledgeStoreOptions): PostgresKnowledgeStore;
export declare function createPgvectorHnswIndexSql(options: PgvectorHnswIndexOptions): string;
export declare function createInMemoryKnowledgeStore(options?: InMemoryKnowledgeStoreOptions): InMemoryKnowledgeStore;
export declare class InMemoryKnowledgeStore implements KnowledgeStore {
    private readonly chunks;
    private readonly now;
    private readonly profiles;
    private readonly sources;
    private readonly spaces;
    constructor(options?: InMemoryKnowledgeStoreOptions);
    searchByEmbedding(options: DenseKnowledgeSearchOptions): Promise<RetrievalResult[]>;
    searchByText(options: LexicalKnowledgeSearchOptions): Promise<RetrievalResult[]>;
    activateEmbeddingProfile(options: ActivateEmbeddingProfileOptions): Promise<void>;
    clear(): Promise<void>;
    deleteKnowledgeSource(sourceId: string): Promise<void>;
    getActiveEmbeddingProfile(filter: ActiveEmbeddingProfileFilter): Promise<EmbeddingProfileRecord | null>;
    listKnowledgeSources(options: KnowledgeSourceListOptions): Promise<KnowledgeSourceRecord[]>;
    markKnowledgeSourcesNeedingReindex(options: MarkKnowledgeSourcesNeedingReindexOptions): Promise<number>;
    upsertEmbeddingProfile(record: EmbeddingProfileRecord): Promise<EmbeddingProfileRecord>;
    upsertKnowledgeChunk(record: KnowledgeChunkRecord): Promise<KnowledgeChunkRecord>;
    upsertKnowledgeSource(record: KnowledgeSourceRecord): Promise<KnowledgeSourceRecord>;
    upsertKnowledgeSpace(record: KnowledgeSpaceRecord): Promise<KnowledgeSpaceRecord>;
}
export declare class PostgresKnowledgeStore implements KnowledgeStore {
    private readonly connectionString;
    private ensureSchemaPromise;
    private readonly ensureVectorExtension;
    private internalPool;
    private readonly now;
    private readonly pool;
    private readonly schemaName;
    private readonly searchConfig;
    private readonly tableNames;
    constructor(options?: PostgresKnowledgeStoreOptions);
    static fromEnv(options?: Omit<PostgresKnowledgeStoreOptions, 'connectionString'>): PostgresKnowledgeStore;
    close(): Promise<void>;
    ensureSchema(): Promise<void>;
    searchByEmbedding(options: DenseKnowledgeSearchOptions): Promise<RetrievalResult[]>;
    searchByText(options: LexicalKnowledgeSearchOptions): Promise<RetrievalResult[]>;
    activateEmbeddingProfile(options: PostgresActivateEmbeddingProfileOptions): Promise<void>;
    getActiveEmbeddingProfile(filter: PostgresActiveEmbeddingProfileFilter): Promise<PostgresEmbeddingProfileRecord | null>;
    listKnowledgeSources(options: PostgresKnowledgeSourceListOptions): Promise<PostgresKnowledgeSourceRecord[]>;
    markKnowledgeSourcesNeedingReindex(options: PostgresMarkKnowledgeSourcesNeedingReindexOptions): Promise<number>;
    upsertEmbeddingProfile(record: PostgresEmbeddingProfileRecord): Promise<PostgresEmbeddingProfileRecord>;
    upsertKnowledgeChunk(record: PostgresKnowledgeChunkRecord): Promise<PostgresKnowledgeChunkRecord>;
    upsertKnowledgeSource(record: PostgresKnowledgeSourceRecord): Promise<PostgresKnowledgeSourceRecord>;
    upsertKnowledgeSpace(record: PostgresKnowledgeSpaceRecord): Promise<PostgresKnowledgeSpaceRecord>;
    private assertEmbeddingProfileImmutability;
    private qualifiedTableName;
    private getPool;
    private runEnsureSchema;
}
//# sourceMappingURL=retrieval.d.ts.map