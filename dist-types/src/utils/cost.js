import { ModelRegistry } from '../models/registry.js';
export function calcCostUSD(input, registry = new ModelRegistry()) {
    if (!registry.isSupported(input.model)) {
        return 0;
    }
    const model = registry.get(input.model);
    return roundUsd(costForTokens(input.inputTokens, model.inputPrice) +
        costForTokens(input.outputTokens, model.outputPrice) +
        costForTokens(input.cachedReadTokens ?? 0, model.cacheReadPrice ?? model.inputPrice * 0.1) +
        costForTokens(input.cachedWriteTokens ?? 0, model.cacheWritePrice ?? model.inputPrice * 1.25));
}
export function formatCost(usd) {
    if (usd === 0) {
        return '$0.00';
    }
    if (Math.abs(usd) < 0.01) {
        return `$${usd.toFixed(4)}`;
    }
    return `$${usd.toFixed(2)}`;
}
export function anthropicUsageToCanonical(usage) {
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
export function openaiUsageToCanonical(usage) {
    const cachedReadTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
        cachedReadTokens,
        cachedTokens: cachedReadTokens,
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
    };
}
export function geminiUsageToCanonical(usage) {
    const cachedTokens = usage?.cachedContentTokenCount ?? 0;
    return {
        cachedTokens,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
    };
}
export function usageWithCost(model, usage) {
    const registry = new ModelRegistry({
        [model.id]: toRegistryEntry(model),
    });
    const costInput = {
        inputTokens: usage.inputTokens,
        model: model.id,
        outputTokens: usage.outputTokens,
    };
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
function costForTokens(tokens, pricePerMillion) {
    return (tokens / 1_000_000) * pricePerMillion;
}
function roundUsd(value) {
    return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
function toRegistryEntry(model) {
    const entry = {
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
