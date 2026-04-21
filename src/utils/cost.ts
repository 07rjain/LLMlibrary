import { ModelRegistry } from '../models/registry.js';

import type { ModelInfo, UsageMetrics } from '../types.js';

export interface CostCalculationInput {
  billedInputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
}

export interface CanonicalUsageCounts {
  billedInputTokens?: number;
  cachedReadTokens?: number;
  cachedTokens: number;
  cachedWriteTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

export interface OpenAIUsagePayload {
  completion_tokens?: number;
  input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens?: number;
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

export function calcCostUSD(
  input: CostCalculationInput,
  registry: ModelRegistry = new ModelRegistry(),
): number {
  if (!registry.isSupported(input.model)) {
    return 0;
  }

  const model = registry.get(input.model);
  const billedInputTokens = input.billedInputTokens ?? input.inputTokens;

  return roundUsd(
    costForTokens(billedInputTokens, model.inputPrice) +
      costForTokens(input.outputTokens, model.outputPrice) +
      costForTokens(
        input.cachedReadTokens ?? 0,
        model.cacheReadPrice ?? model.inputPrice * 0.1,
      ) +
      costForTokens(
        input.cachedWriteTokens ?? 0,
        model.cacheWritePrice ?? model.inputPrice * 1.25,
      ),
  );
}

export function formatCost(usd: number): string {
  if (usd === 0) {
    return '$0.00';
  }

  if (Math.abs(usd) < 0.01) {
    return `$${usd.toFixed(4)}`;
  }

  return `$${usd.toFixed(2)}`;
}

export function anthropicUsageToCanonical(
  usage: AnthropicUsagePayload | undefined,
): CanonicalUsageCounts {
  const cachedReadTokens = usage?.cache_read_input_tokens ?? 0;
  const cachedWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  return {
    cachedReadTokens,
    cachedTokens: cachedReadTokens + cachedWriteTokens,
    cachedWriteTokens,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

export function openaiUsageToCanonical(
  usage: OpenAIUsagePayload | undefined,
): CanonicalUsageCounts {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const cachedReadTokens =
    usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    0;
  return {
    billedInputTokens: Math.max(inputTokens - cachedReadTokens, 0),
    cachedReadTokens,
    cachedTokens: cachedReadTokens,
    inputTokens,
    outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
  };
}

export function geminiUsageToCanonical(
  usage: GeminiUsagePayload | undefined,
): CanonicalUsageCounts {
  const inputTokens = usage?.promptTokenCount ?? 0;
  const cachedTokens = usage?.cachedContentTokenCount ?? 0;
  return {
    billedInputTokens: Math.max(inputTokens - cachedTokens, 0),
    cachedReadTokens: cachedTokens,
    cachedTokens,
    inputTokens,
    outputTokens: usage?.candidatesTokenCount ?? 0,
  };
}

export function usageWithCost(
  model: ModelInfo,
  usage: CanonicalUsageCounts,
): UsageMetrics {
  const registry = new ModelRegistry({
    [model.id]: toRegistryEntry(model),
  });
  const costInput: CostCalculationInput = {
    inputTokens: usage.inputTokens,
    model: model.id,
    outputTokens: usage.outputTokens,
  };

  if (usage.billedInputTokens !== undefined) {
    costInput.billedInputTokens = usage.billedInputTokens;
  }

  if (usage.cachedReadTokens !== undefined) {
    costInput.cachedReadTokens = usage.cachedReadTokens;
  }

  if (usage.cachedWriteTokens !== undefined) {
    costInput.cachedWriteTokens = usage.cachedWriteTokens;
  }

  const costUSD = calcCostUSD(costInput, registry);

  return {
    ...usage,
    cost: formatCost(costUSD),
    costUSD,
  };
}

function costForTokens(tokens: number, pricePerMillion: number): number {
  return (tokens / 1_000_000) * pricePerMillion;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function toRegistryEntry(model: ModelInfo): Omit<ModelInfo, 'id'> {
  const entry: Omit<ModelInfo, 'id'> = {
    contextWindow: model.contextWindow,
    inputPrice: model.inputPrice,
    lastUpdated: model.lastUpdated,
    outputPrice: model.outputPrice,
    provider: model.provider,
    supportsStreaming: model.supportsStreaming,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
  };

  if (model.cacheReadPrice !== undefined) {
    entry.cacheReadPrice = model.cacheReadPrice;
  }

  if (model.cacheWritePrice !== undefined) {
    entry.cacheWritePrice = model.cacheWritePrice;
  }

  return entry;
}
