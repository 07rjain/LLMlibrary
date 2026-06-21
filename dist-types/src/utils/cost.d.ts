import { ModelRegistry } from '../models/registry.js';
import type { ModelInfo, SpeechBillingUnits, SpeechCostLineItem, SpeechUsageMetrics, UsageMetrics } from '../types.js';
export interface CostCalculationInput {
    billedInputTokens?: number;
    billableReasoningTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    inputTokens: number;
    model: string;
    outputTokens: number;
}
export interface CanonicalUsageCounts {
    billedInputTokens?: number;
    billableReasoningTokens?: number;
    cachedReadTokens?: number;
    cachedTokens: number;
    cachedWriteTokens?: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
}
export interface SpeechCostCalculationInput {
    audioInputTokens?: number;
    audioOutputTokens?: number;
    estimated?: boolean;
    inputAudioSeconds?: number;
    inputCharacters?: number;
    inputTokens?: number;
    model: string;
    outputAudioSeconds?: number;
    outputCharacters?: number;
    outputTokens?: number;
}
export interface SpeechCostResult {
    billingUnits: SpeechBillingUnits;
    cost?: string;
    costBreakdown: SpeechCostLineItem[];
    costUSD?: number;
    estimated: boolean;
}
export interface OpenAIUsagePayload {
    completion_tokens?: number;
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
    input_tokens?: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
    output_tokens?: number;
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
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
    thoughtsTokenCount?: number;
}
export declare function calcCostUSD(input: CostCalculationInput, registry?: ModelRegistry): number;
export declare function calcSpeechCostUSD(input: SpeechCostCalculationInput, registry?: ModelRegistry): SpeechCostResult;
export declare function speechUsageWithCost(model: ModelInfo, usage: Omit<SpeechUsageMetrics, 'billingUnits' | 'cost' | 'costBreakdown' | 'costUSD'>): SpeechUsageMetrics;
export declare function formatCost(usd: number): string;
export declare function anthropicUsageToCanonical(usage: AnthropicUsagePayload | undefined): CanonicalUsageCounts;
export declare function openaiUsageToCanonical(usage: OpenAIUsagePayload | undefined): CanonicalUsageCounts;
export declare function geminiUsageToCanonical(usage: GeminiUsagePayload | undefined): CanonicalUsageCounts;
export declare function usageWithCost(model: ModelInfo, usage: CanonicalUsageCounts): UsageMetrics;
//# sourceMappingURL=cost.d.ts.map