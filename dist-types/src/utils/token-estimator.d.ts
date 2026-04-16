import type { CanonicalMessage, CanonicalTool, CanonicalToolChoice } from '../types.js';
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
export interface OpenAICountTokensOptions {
    messages: CanonicalMessage[];
    model: string;
    system?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
}
export declare function estimateTokens(text: string): number;
export declare function estimateMessageTokens(messages: CanonicalMessage[]): number;
export declare function anthropicCountTokens(options: AnthropicCountTokensOptions): Promise<number>;
export declare function geminiCountTokens(options: GeminiCountTokensOptions): Promise<number>;
export declare function openaiCountTokens(options: OpenAICountTokensOptions): Promise<number>;
//# sourceMappingURL=token-estimator.d.ts.map