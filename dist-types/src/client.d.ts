import { ModelRegistry } from './models/registry.js';
import { Conversation } from './conversation.js';
import type { ModelRegistryOptions, ModelPriceOverrides } from './models/index.js';
import type { ConversationOptions, ConversationSnapshot } from './conversation.js';
import type { GeminiCachedContent, GeminiCachedContentPage, GeminiCreateCacheOptions, GeminiListCachesOptions, GeminiUpdateCacheOptions } from './providers/gemini.js';
import type { SessionStore } from './session-store.js';
import type { ModelRouter } from './router.js';
import type { CanonicalMessage, CanonicalProvider, CanonicalResponse, CanonicalTool, CanonicalToolChoice, BudgetExceededAction, CancelableStream, EmbeddingProvider, EmbeddingRequestOptions, EmbeddingResponse, ProviderOptions, RemoteModelInfo, RemoteModelListOptions, StreamChunk } from './types.js';
import type { UsageExportFormat, UsageLogger, UsageQuery, UsageSummary } from './usage.js';
import type { RetryOptions } from './utils/retry.js';
/** Constructor options for `LLMClient`. */
export interface LLMClientOptions {
    anthropicApiKey?: string;
    budgetExceededAction?: BudgetExceededAction;
    defaultEmbeddingModel?: string;
    defaultEmbeddingProvider?: EmbeddingProvider;
    defaultModel?: string;
    defaultProvider?: CanonicalProvider;
    fetchImplementation?: typeof fetch;
    geminiApiKey?: string;
    modelRegistry?: ModelRegistry;
    modelRegistryOptions?: ModelRegistryOptions;
    modelRouter?: ModelRouter;
    onWarning?: (message: string) => void;
    openaiApiKey?: string;
    openaiOrganization?: string;
    openaiProject?: string;
    retryOptions?: RetryOptions;
    sessionStore?: SessionStore<ConversationSnapshot>;
    usageLogger?: UsageLogger;
}
/** Canonical request options shared by `complete()` and `stream()`. */
export interface LLMRequestOptions {
    botId?: string;
    budgetExceededAction?: BudgetExceededAction;
    budgetUsd?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    providerOptions?: ProviderOptions;
    sessionId?: string;
    signal?: AbortSignal;
    system?: string;
    temperature?: number;
    tenantId?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
}
/** Configuration for `LLMClient.mock()` test instances. */
export interface MockLLMClientOptions extends Omit<LLMClientOptions, 'anthropicApiKey' | 'geminiApiKey' | 'openaiApiKey'> {
    embeddings?: Array<EmbeddingResponse | ((options: EmbeddingRequestOptions & {
        model: string;
        provider: EmbeddingProvider;
    }) => EmbeddingResponse | Promise<EmbeddingResponse>)>;
    responses?: Array<CanonicalResponse | ((options: LLMRequestOptions & {
        maxTokens: number;
        model: string;
        provider: CanonicalProvider;
    }) => CanonicalResponse | Promise<CanonicalResponse>)>;
    streams?: Array<AsyncIterable<StreamChunk> | StreamChunk[] | ((options: LLMRequestOptions & {
        maxTokens: number;
        model: string;
        provider: CanonicalProvider;
    }) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk> | StreamChunk[]> | StreamChunk[])>;
}
/**
 * Unified entry point for provider-agnostic completions, streaming,
 * conversations, routing, and usage logging.
 *
 * @example
 * ```ts
 * const client = LLMClient.fromEnv({
 *   defaultModel: 'gpt-4o',
 * });
 *
 * const response = await client.complete({
 *   messages: [{ content: 'Say hello.', role: 'user' }],
 * });
 * ```
 */
export declare class LLMClient {
    private readonly anthropicAdapter;
    private readonly budgetExceededAction;
    private readonly defaultEmbeddingModel;
    private readonly defaultEmbeddingProvider;
    private readonly defaultModel;
    private readonly defaultProvider;
    private readonly geminiAdapter;
    private readonly modelRegistry;
    private readonly modelRouter;
    private readonly onWarning;
    private readonly openaiAdapter;
    private readonly sessionStore;
    private readonly usageLogger;
    readonly models: {
        get: ModelRegistry['get'];
        list: ModelRegistry['list'];
        listRemote: (options: RemoteModelListOptions) => Promise<RemoteModelInfo[]>;
        register: ModelRegistry['register'];
    };
    readonly googleCaches: {
        create: (options: GeminiCreateCacheOptions) => Promise<GeminiCachedContent>;
        delete: (name: string) => Promise<void>;
        get: (name: string) => Promise<GeminiCachedContent>;
        list: (options?: GeminiListCachesOptions) => Promise<GeminiCachedContentPage>;
        update: (name: string, options: GeminiUpdateCacheOptions) => Promise<GeminiCachedContent>;
    };
    constructor(options?: LLMClientOptions);
    /**
     * Creates a client that reads provider credentials from the current
     * environment.
     */
    static fromEnv(options?: Omit<LLMClientOptions, 'anthropicApiKey' | 'geminiApiKey' | 'openaiApiKey'>): LLMClient;
    /** Creates a deterministic in-memory client for tests. */
    static mock(options?: MockLLMClientOptions): LLMClient;
    /** Executes a single non-streaming completion request. */
    complete(options: LLMRequestOptions): Promise<CanonicalResponse>;
    /** Executes a single non-streaming embedding request. */
    embed(options: EmbeddingRequestOptions): Promise<EmbeddingResponse>;
    /** Executes a streaming completion request and yields canonical chunks. */
    stream(options: LLMRequestOptions): CancelableStream<StreamChunk>;
    /**
     * Creates or restores a conversation, automatically hydrating from the
     * configured session store when a matching `sessionId` exists.
     */
    conversation(options?: Omit<ConversationOptions, 'store'>): Promise<Conversation>;
    /** Applies runtime price overrides to the shared model registry. */
    updatePrices(overrides: ModelPriceOverrides): void;
    /** Returns aggregated usage from the configured usage logger. */
    getUsage(query?: UsageQuery): Promise<UsageSummary>;
    /** Returns aggregated usage serialized as JSON or CSV. */
    exportUsage(format: UsageExportFormat, query?: UsageQuery): Promise<string>;
    /** Returns the session store configured on this client, if any. */
    getSessionStore(): SessionStore<ConversationSnapshot> | undefined;
    private getAnthropicAdapter;
    private getGeminiAdapter;
    private getOpenAIAdapter;
    private listRemoteModels;
    private dispatchComplete;
    private dispatchEmbed;
    private dispatchStream;
    private resolveRequest;
    private resolveEmbeddingRequest;
    private resolveRequestPlan;
    private resolveRoute;
    private buildRouterContext;
    private resolveBudgetExceededError;
    private handleBudgetExceededAction;
    private logUsageEvent;
    private streamWithFallback;
}
//# sourceMappingURL=client.d.ts.map