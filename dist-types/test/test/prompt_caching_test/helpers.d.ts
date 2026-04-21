import type { CanonicalResponse } from '../../src/types.js';
export interface PromptCachingResponseSummary {
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
export declare function loadPromptCachingEnv(): void;
export declare function buildCachedPrefix(label: string, repeats?: number): string;
export declare function summarizeResponse(response: CanonicalResponse): PromptCachingResponseSummary;
export declare function logPromptCachingResult(provider: string, payload: unknown): void;
//# sourceMappingURL=helpers.d.ts.map