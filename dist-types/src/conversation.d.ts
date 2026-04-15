import type { ContextManager } from './context-manager.js';
import type { SessionStore } from './session-store.js';
import type { CanonicalMessage, CanonicalProvider, CanonicalResponse, CanonicalTool, CanonicalToolChoice, StreamChunk } from './types.js';
/** Minimal client contract consumed by `Conversation`. */
export interface ConversationClient {
    complete(options: {
        budgetUsd?: number;
        maxTokens?: number;
        messages: CanonicalMessage[];
        model?: string;
        provider?: CanonicalProvider;
        sessionId?: string;
        signal?: AbortSignal;
        system?: string;
        tenantId?: string;
        toolChoice?: CanonicalToolChoice;
        tools?: CanonicalTool[];
    }): Promise<CanonicalResponse>;
    stream(options: {
        budgetUsd?: number;
        maxTokens?: number;
        messages: CanonicalMessage[];
        model?: string;
        provider?: CanonicalProvider;
        sessionId?: string;
        signal?: AbortSignal;
        system?: string;
        tenantId?: string;
        toolChoice?: CanonicalToolChoice;
        tools?: CanonicalTool[];
    }): AsyncIterable<StreamChunk>;
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
    sessionId: string;
    system?: string;
    tenantId?: string;
    toolExecutionTimeoutMs?: number;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
    totalCachedTokens: number;
    totalCostUSD: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    updatedAt: string;
}
/** Configuration for a new or restored `Conversation`. */
export interface ConversationOptions {
    budgetUsd?: number;
    contextManager?: ContextManager;
    maxToolRounds?: number;
    maxContextTokens?: number;
    maxTokens?: number;
    messages?: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    sessionId?: string;
    store?: SessionStore<ConversationSnapshot>;
    system?: string;
    tenantId?: string;
    toolExecutionTimeoutMs?: number;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
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
    private readonly sessionId;
    private readonly store;
    private system;
    private readonly tenantId;
    private readonly toolExecutionTimeoutMs;
    private readonly toolChoice;
    private readonly tools;
    private totalCachedTokens;
    private totalCostUSD;
    private totalInputTokens;
    private totalOutputTokens;
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
    };
    /** Appends a user turn, executes the model/tool loop, and commits state. */
    send(input: CanonicalMessage['content'], options?: {
        signal?: AbortSignal;
    }): Promise<CanonicalResponse>;
    /** Streams a user turn and commits state when the final `done` chunk arrives. */
    sendStream(input: CanonicalMessage['content'], options?: {
        signal?: AbortSignal;
    }): AsyncGenerator<StreamChunk, void, void>;
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
    private runCompleteToolLoop;
    private runStreamToolLoop;
    private shouldContinueToolLoop;
    private assertNextToolRound;
    private executeToolCalls;
    private executeToolCall;
    private finalizeExecution;
    private persist;
    private buildContextManagerContext;
    private buildRequestOptions;
    private resolveRemainingBudgetUsd;
}
//# sourceMappingURL=conversation.d.ts.map