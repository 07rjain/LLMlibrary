import { ModelRegistry } from './models/registry.js';
import { Conversation } from './conversation.js';
import type { ModelRegistryOptions, ModelPriceOverrides } from './models/index.js';
import type { ConversationOptions, ConversationSnapshot } from './conversation.js';
import type { SessionStore } from './session-store.js';
import type { ModelRouter } from './router.js';
import type { CanonicalMessage, CanonicalProvider, CanonicalResponse, CanonicalTool, CanonicalToolChoice, StreamChunk } from './types.js';
import type { UsageLogger, UsageQuery, UsageSummary } from './usage.js';
import type { RetryOptions } from './utils/retry.js';
/** Constructor options for `LLMClient`. */
export interface LLMClientOptions {
    anthropicApiKey?: string;
    defaultModel?: string;
    defaultProvider?: CanonicalProvider;
    fetchImplementation?: typeof fetch;
    geminiApiKey?: string;
    modelRegistry?: ModelRegistry;
    modelRegistryOptions?: ModelRegistryOptions;
    modelRouter?: ModelRouter;
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
    budgetUsd?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
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
    private readonly defaultModel;
    private readonly defaultProvider;
    private readonly geminiAdapter;
    private readonly modelRegistry;
    private readonly modelRouter;
    private readonly openaiAdapter;
    private readonly sessionStore;
    private readonly usageLogger;
    readonly models: {
        get: ModelRegistry['get'];
        list: ModelRegistry['list'];
        register: ModelRegistry['register'];
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
    /** Executes a streaming completion request and yields canonical chunks. */
    stream(options: LLMRequestOptions): AsyncIterable<StreamChunk>;
    /**
     * Creates or restores a conversation, automatically hydrating from the
     * configured session store when a matching `sessionId` exists.
     */
    conversation(options?: Omit<ConversationOptions, 'store'>): Promise<Conversation>;
    /** Applies runtime price overrides to the shared model registry. */
    updatePrices(overrides: ModelPriceOverrides): void;
    /** Returns aggregated usage from the configured usage logger. */
    getUsage(query?: UsageQuery): Promise<UsageSummary>;
    /** Returns the session store configured on this client, if any. */
    getSessionStore(): SessionStore<ConversationSnapshot> | undefined;
    private getAnthropicAdapter;
    private getGeminiAdapter;
    private getOpenAIAdapter;
    private dispatchComplete;
    private dispatchStream;
    private resolveRequest;
    private resolveRequestPlan;
    private resolveRoute;
    private buildRouterContext;
    private assertBudget;
    private logUsageEvent;
    private streamWithFallback;
}
//# sourceMappingURL=client.d.ts.map