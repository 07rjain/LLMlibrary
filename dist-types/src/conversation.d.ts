import type { ContextManager } from './context-manager.js';
import type { SessionStore } from './session-store.js';
import type { BudgetExceededAction, CancelableStream, CanonicalMessage, CanonicalProvider, CanonicalResponse, CanonicalTool, CanonicalToolChoice, JsonValue, ProviderOptions, ResponseFormat, StreamChunk, ToolCallDispatcher } from './types.js';
export type ToolValidationMode = 'permissive' | 'strict';
/** Resolved route metadata used to prepare one conversation turn. */
export interface ConversationRoute {
    attempts?: Array<{
        decision: string;
        model: string;
        provider: CanonicalProvider;
    }>;
    contextWindow?: number;
    model: string;
    provider: CanonicalProvider;
}
/** Minimal client contract consumed by `Conversation`. */
export interface ConversationClient {
    resolveContext?(options: {
        maxTokens?: number;
        messages: CanonicalMessage[];
        model?: string;
        provider?: CanonicalProvider;
        responseFormat?: ResponseFormat;
        sessionId?: string;
        system?: string;
        tenantId?: string;
        toolChoice?: CanonicalToolChoice;
        tools?: CanonicalTool[];
    }): ConversationRoute;
    complete(options: {
        budgetExceededAction?: BudgetExceededAction;
        budgetUsd?: number;
        metadata?: Record<string, JsonValue>;
        maxTokens?: number;
        messages: CanonicalMessage[];
        model?: string;
        provider?: CanonicalProvider;
        resolvedRoute?: {
            attempts?: ConversationRoute['attempts'];
            model: string;
            provider: CanonicalProvider;
        };
        providerOptions?: ProviderOptions;
        requestId?: string;
        responseFormat?: ResponseFormat;
        sessionId?: string;
        signal?: AbortSignal;
        system?: string;
        tenantId?: string;
        toolChoice?: CanonicalToolChoice;
        tools?: CanonicalTool[];
    }): Promise<CanonicalResponse>;
    stream(options: {
        budgetExceededAction?: BudgetExceededAction;
        budgetUsd?: number;
        metadata?: Record<string, JsonValue>;
        maxTokens?: number;
        messages: CanonicalMessage[];
        model?: string;
        provider?: CanonicalProvider;
        resolvedRoute?: {
            attempts?: ConversationRoute['attempts'];
            model: string;
            provider: CanonicalProvider;
        };
        providerOptions?: ProviderOptions;
        requestId?: string;
        responseFormat?: ResponseFormat;
        sessionId?: string;
        signal?: AbortSignal;
        system?: string;
        tenantId?: string;
        toolChoice?: CanonicalToolChoice;
        tools?: CanonicalTool[];
    }): AsyncIterable<StreamChunk>;
}
/** Correlation and cancellation options for one conversation turn. */
export interface ConversationRequestOptions {
    metadata?: Record<string, JsonValue>;
    requestId?: string;
    signal?: AbortSignal;
}
/** Serializable conversation state persisted by session stores. */
export interface ConversationSnapshot {
    budgetUsd?: number;
    createdAt: string;
    maxToolRounds?: number;
    maxContextTokens?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    providerOptions?: ProviderOptions;
    responseFormat?: ResponseFormat;
    sessionId: string;
    system?: string;
    tenantId?: string;
    toolExecutionTimeoutMs?: number;
    toolValidation?: ToolValidationMode;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
    totalCachedTokens: number;
    totalCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens?: number;
    updatedAt: string;
}
/** Configuration for a new or restored `Conversation`. */
export interface ConversationOptions {
    budgetExceededAction?: BudgetExceededAction;
    budgetUsd?: number;
    contextManager?: ContextManager;
    maxToolRounds?: number;
    maxContextTokens?: number;
    maxTokens?: number;
    messages?: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    providerOptions?: ProviderOptions;
    responseFormat?: ResponseFormat;
    sessionId?: string;
    store?: SessionStore<ConversationSnapshot>;
    system?: string;
    toolCallDispatcherMetadata?: Record<string, JsonValue>;
    tenantId?: string;
    toolExecutionTimeoutMs?: number;
    toolValidation?: ToolValidationMode;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
    toolCallDispatcher?: ToolCallDispatcher;
    onWarning?: (message: string) => void;
    onCompaction?: (event: {
        afterCount: number;
        beforeCount: number;
        removedCount: number;
        toolRound: number;
    }) => void;
}
/**
 * Stateful conversation wrapper that handles history, tool execution,
 * persistence, and running token/cost totals.
 *
 * @example
 * ```ts
 * const conversation = await client.conversation({
 *   sessionId: 'support-1',
 *   system: 'Be concise.',
 * });
 *
 * await conversation.send('Summarise the issue.');
 * ```
 */
export declare class Conversation {
    private readonly budgetExceededAction;
    private readonly client;
    private readonly contextManager;
    private createdAt;
    private readonly budgetUsd;
    private readonly maxToolRounds;
    private readonly maxContextTokens;
    private readonly maxTokens;
    private messages;
    private model;
    private provider;
    private readonly providerOptions;
    private readonly responseFormat;
    private readonly sessionId;
    private readonly store;
    private system;
    private readonly toolCallDispatcherMetadata;
    private readonly tenantId;
    private readonly toolExecutionTimeoutMs;
    private readonly toolValidation;
    private readonly toolChoice;
    private readonly tools;
    private readonly toolCallDispatcher;
    private readonly onWarning;
    private readonly onCompaction;
    private totalCachedTokens;
    private totalCostUSD;
    private totalInputTokens;
    private totalOutputTokens;
    private totalReasoningTokens;
    private updatedAt;
    constructor(client: ConversationClient, options?: ConversationOptions);
    get cost(): string;
    get history(): CanonicalMessage[];
    get id(): string;
    get totals(): {
        cachedTokens: number;
        cost: string;
        costUSD: number;
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
    };
    /** Appends a user turn, executes the model/tool loop, and commits state. */
    send(input: CanonicalMessage['content'], options?: ConversationRequestOptions): Promise<CanonicalResponse>;
    /** Streams a user turn and commits state when the final `done` chunk arrives. */
    sendStream(input: CanonicalMessage['content'], options?: ConversationRequestOptions): CancelableStream<StreamChunk>;
    /** Clears non-system history while preserving running totals. */
    clear(): void;
    /** Serializes the conversation for storage or transport. */
    serialise(): ConversationSnapshot;
    /** Returns the full message list including the pinned system prompt. */
    toMessages(): CanonicalMessage[];
    /** Exports the conversation as a markdown transcript. */
    toMarkdown(): string;
    /** Restores a conversation from a serialized snapshot. */
    static restore(client: ConversationClient, snapshot: ConversationSnapshot, options?: Omit<ConversationOptions, 'messages'>): Conversation;
    private applyUsage;
    private prepareMessages;
    private prepareModelStepMessages;
    private runCompleteToolLoop;
    private runStreamToolLoop;
    private shouldContinueToolLoop;
    private assertNextToolRound;
    private executeToolCalls;
    private executeToolCall;
    private finalizeExecution;
    private persist;
    private resolveConversationRoute;
    private buildContextManagerContext;
    private buildRequestOptions;
    private resolveRemainingBudgetDecision;
}
//# sourceMappingURL=conversation.d.ts.map