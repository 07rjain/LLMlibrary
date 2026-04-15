import type { CanonicalMessage, CanonicalProvider } from './types.js';
type MaybePromise<TValue> = Promise<TValue> | TValue;
/** Metadata passed to context trimming strategies before a model call. */
export interface ContextManagerContext {
    maxContextTokens?: number;
    model?: string;
    provider?: CanonicalProvider;
    system?: string;
}
/** Contract for pluggable context trimming strategies. */
export interface ContextManager {
    shouldTrim(messages: CanonicalMessage[], context: ContextManagerContext): MaybePromise<boolean>;
    trim(messages: CanonicalMessage[], context: ContextManagerContext): MaybePromise<CanonicalMessage[]>;
}
/** Configuration for the sliding-window trimming strategy. */
export interface SlidingWindowStrategyOptions {
    maxMessages?: number;
    maxTokens?: number;
    onTrim?: (event: {
        afterCount: number;
        beforeCount: number;
        estimatedTokens: number;
        removedCount: number;
    }) => void;
    tokenEstimator?: (messages: CanonicalMessage[]) => number;
}
/**
 * Drops the oldest removable messages when message-count or token estimates
 * exceed the configured budget.
 *
 * @example
 * ```ts
 * const strategy = new SlidingWindowStrategy({
 *   maxMessages: 12,
 *   maxTokens: 16_000,
 * });
 * ```
 */
export declare class SlidingWindowStrategy implements ContextManager {
    private readonly maxMessages;
    private readonly maxTokens;
    private readonly onTrim;
    private readonly tokenEstimator;
    constructor(options?: SlidingWindowStrategyOptions);
    shouldTrim(messages: CanonicalMessage[], context: ContextManagerContext): boolean;
    trim(messages: CanonicalMessage[], context: ContextManagerContext): CanonicalMessage[];
    private estimateTokens;
    private exceedsMessageLimit;
}
export interface SummarisationStrategyOptions extends SlidingWindowStrategyOptions {
    keepLastMessages?: number;
    summarizer: (messages: CanonicalMessage[], context: ContextManagerContext) => MaybePromise<string>;
    summaryMetadata?: Record<string, unknown>;
}
/**
 * Replaces older removable history with a summary message before falling back to
 * sliding-window trimming.
 *
 * @example
 * ```ts
 * const strategy = new SummarisationStrategy({
 *   maxMessages: 10,
 *   keepLastMessages: 2,
 *   summarizer: async (messages) => `Summary of ${messages.length} messages`,
 * });
 * ```
 */
export declare class SummarisationStrategy implements ContextManager {
    private readonly baseStrategy;
    private readonly keepLastMessages;
    private readonly summarizer;
    private readonly summaryMetadata;
    constructor(options: SummarisationStrategyOptions);
    shouldTrim(messages: CanonicalMessage[], context: ContextManagerContext): boolean;
    trim(messages: CanonicalMessage[], context: ContextManagerContext): Promise<CanonicalMessage[]>;
}
export {};
//# sourceMappingURL=context-manager.d.ts.map