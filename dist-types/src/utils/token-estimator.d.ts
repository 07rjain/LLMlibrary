import type { CanonicalMessage } from '../types.js';
export interface AnthropicCountTokensOptions {
    apiKey: string;
    body: Record<string, unknown>;
    fetchImplementation?: typeof fetch;
    signal?: AbortSignal;
    url?: string;
}
export interface GeminiCountTokensOptions {
    apiKey: string;
    body: Record<string, unknown>;
    fetchImplementation?: typeof fetch;
    model: string;
    signal?: AbortSignal;
    url?: string;
}
export declare function estimateTokens(text: string): number;
export declare function estimateMessageTokens(messages: CanonicalMessage[]): number;
export declare function anthropicCountTokens(options: AnthropicCountTokensOptions): Promise<number>;
export declare function geminiCountTokens(options: GeminiCountTokensOptions): Promise<number>;
//# sourceMappingURL=token-estimator.d.ts.map