export interface RetryOptions {
    baseMs?: number;
    jitterMs?: number;
    maxAttempts?: number;
    maxMs?: number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
}
export interface GeminiErrorDetail {
    '@type'?: string;
    retryDelay?: number | string | {
        nanos?: number;
        seconds?: number | string;
    };
}
export interface GeminiErrorResponseShape {
    error?: {
        details?: GeminiErrorDetail[];
    };
}
export declare function parseRetryAfterMs(retryAfter: null | string, nowMs?: number): number | null;
export declare function parseGeminiRetryDelayMs(details: GeminiErrorDetail[] | undefined): number | null;
export declare function withRetry(fn: (attempt: number) => Promise<Response>, options?: RetryOptions): Promise<Response>;
//# sourceMappingURL=retry.d.ts.map