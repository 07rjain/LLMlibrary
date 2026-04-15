import type { CanonicalProvider } from './types.js';
/** Metadata attached to typed LLM errors. */
export interface LLMErrorOptions {
    cause?: unknown;
    details?: Record<string, unknown>;
    model?: string;
    provider?: CanonicalProvider;
    requestId?: string;
    retryable?: boolean;
    statusCode?: number;
}
/** Base error for provider, capability, budget, and transport failures. */
export declare class LLMError extends Error {
    readonly cause: unknown;
    readonly details: Record<string, unknown> | undefined;
    readonly model: string | undefined;
    readonly provider: CanonicalProvider | undefined;
    readonly requestId: string | undefined;
    readonly retryable: boolean;
    readonly statusCode: number | undefined;
    constructor(message: string, options?: LLMErrorOptions);
    toJSON(): Record<string, unknown>;
}
/** Authentication or authorization failure reported by a provider. */
export declare class AuthenticationError extends LLMError {
}
/** Rate-limit or quota exhaustion failure. */
export declare class RateLimitError extends LLMError {
}
/** Context-window or token-limit failure. */
export declare class ContextLimitError extends LLMError {
}
/** Unsupported provider, model, or feature combination. */
export declare class ProviderCapabilityError extends LLMError {
}
/** Budget guard failure raised before or during a request. */
export declare class BudgetExceededError extends LLMError {
}
/** Tool loop exceeded the configured maximum number of rounds. */
export declare class MaxToolRoundsError extends LLMError {
}
/** Generic provider-side failure that does not fit a narrower subtype. */
export declare class ProviderError extends LLMError {
}
//# sourceMappingURL=errors.d.ts.map