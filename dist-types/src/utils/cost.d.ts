import { ModelRegistry } from '../models/registry.js';
import type { ModelInfo, UsageMetrics } from '../types.js';
export interface CostCalculationInput {
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    inputTokens: number;
    model: string;
    outputTokens: number;
}
export interface CanonicalUsageCounts {
    cachedReadTokens?: number;
    cachedTokens: number;
    cachedWriteTokens?: number;
    inputTokens: number;
    outputTokens: number;
}
export interface OpenAIUsagePayload {
    completion_tokens?: number;
    prompt_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
}
export interface AnthropicUsagePayload {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
}
export interface GeminiUsagePayload {
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    promptTokenCount?: number;
}
export declare function calcCostUSD(input: CostCalculationInput, registry?: ModelRegistry): number;
export declare function formatCost(usd: number): string;
export declare function anthropicUsageToCanonical(usage: AnthropicUsagePayload | undefined): CanonicalUsageCounts;
export declare function openaiUsageToCanonical(usage: OpenAIUsagePayload | undefined): CanonicalUsageCounts;
export declare function geminiUsageToCanonical(usage: GeminiUsagePayload | undefined): CanonicalUsageCounts;
export declare function usageWithCost(model: ModelInfo, usage: CanonicalUsageCounts): UsageMetrics;
//# sourceMappingURL=cost.d.ts.map