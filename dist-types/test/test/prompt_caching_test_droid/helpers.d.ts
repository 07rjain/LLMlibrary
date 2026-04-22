import type { CanonicalResponse } from '../../src/types.js';
export interface CachingResponseSummary {
    cachedReadTokens: number;
    cachedTokens: number;
    cachedWriteTokens: number;
    costUSD: number;
    inputTokens: number;
    model: string;
    outputTokens: number;
    provider: string;
    textPreview: string;
}
export declare function loadEnv(): void;
/**
 * Builds a long repeated string that exceeds the 1 024-token minimum needed
 * to trigger OpenAI and Anthropic prompt caching.
 */
export declare function buildLargePrefix(label: string, repeats?: number): string;
export declare function summarize(response: CanonicalResponse): CachingResponseSummary;
export declare function log(provider: string, payload: unknown): void;
//# sourceMappingURL=helpers.d.ts.map