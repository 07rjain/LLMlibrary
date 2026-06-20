import { ModelRegistry } from '../models/registry.js';
export function calcCostUSD(input, registry = new ModelRegistry()) {
    if (!registry.isSupported(input.model)) {
        return 0;
    }
    const model = registry.get(input.model);
    const billedInputTokens = input.billedInputTokens ?? input.inputTokens;
    return roundUsd(costForTokens(billedInputTokens, model.inputPrice) +
        costForTokens(input.outputTokens, model.outputPrice) +
        costForTokens(input.cachedReadTokens ?? 0, model.cacheReadPrice ?? model.inputPrice * 0.1) +
        costForTokens(input.cachedWriteTokens ?? 0, model.cacheWritePrice ?? model.inputPrice * 1.25));
}
export function calcSpeechCostUSD(input, registry = new ModelRegistry()) {
    const billingUnits = buildSpeechBillingUnits(input);
    if (!registry.isSupported(input.model)) {
        return {
            billingUnits,
            costBreakdown: [],
            estimated: input.estimated ?? true,
        };
    }
    const model = registry.get(input.model);
    const prices = model.speechPrices;
    if (!prices) {
        return {
            billingUnits,
            costBreakdown: [],
            estimated: input.estimated ?? true,
        };
    }
    const estimated = input.estimated ?? true;
    const costBreakdown = [];
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Text input',
        quantity: input.inputTokens,
        rateUSD: prices.textInputTokenPrice,
        unit: 'text_input_token',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Text output',
        quantity: input.outputTokens,
        rateUSD: prices.textOutputTokenPrice,
        unit: 'text_output_token',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Audio input tokens',
        quantity: input.audioInputTokens,
        rateUSD: prices.audioInputTokenPrice,
        unit: 'audio_input_token',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Audio output tokens',
        quantity: input.audioOutputTokens,
        rateUSD: prices.audioOutputTokenPrice,
        unit: 'audio_output_token',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Input audio duration',
        quantity: input.inputAudioSeconds,
        rateUSD: prices.inputAudioSecondPrice,
        unit: 'audio_second',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Output audio duration',
        quantity: input.outputAudioSeconds,
        rateUSD: prices.outputAudioSecondPrice,
        unit: 'audio_second',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Input characters',
        quantity: input.inputCharacters,
        rateUSD: prices.characterInputPrice,
        unit: 'character',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Output characters',
        quantity: input.outputCharacters,
        rateUSD: prices.characterOutputPrice,
        unit: 'character',
    });
    addSpeechCostLine(costBreakdown, {
        estimated,
        label: 'Request',
        quantity: prices.requestPrice === undefined ? undefined : 1,
        rateUSD: prices.requestPrice,
        unit: 'request',
    });
    if (costBreakdown.length === 0) {
        return {
            billingUnits,
            costBreakdown,
            estimated,
        };
    }
    const costUSD = roundUsd(costBreakdown.reduce((sum, item) => sum + item.amountUSD, 0));
    return {
        billingUnits,
        cost: formatCost(costUSD),
        costBreakdown,
        costUSD,
        estimated,
    };
}
export function speechUsageWithCost(model, usage) {
    const registry = new ModelRegistry({
        [model.id]: toRegistryEntry(model),
    });
    const cost = calcSpeechCostUSD({
        ...(usage.audioInputTokens !== undefined ? { audioInputTokens: usage.audioInputTokens } : {}),
        ...(usage.audioOutputTokens !== undefined ? { audioOutputTokens: usage.audioOutputTokens } : {}),
        ...(usage.estimated !== undefined ? { estimated: usage.estimated } : {}),
        ...(usage.inputAudioSeconds !== undefined ? { inputAudioSeconds: usage.inputAudioSeconds } : {}),
        ...(usage.inputCharacters !== undefined ? { inputCharacters: usage.inputCharacters } : {}),
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        model: model.id,
        ...(usage.outputAudioSeconds !== undefined ? { outputAudioSeconds: usage.outputAudioSeconds } : {}),
        ...(usage.outputCharacters !== undefined ? { outputCharacters: usage.outputCharacters } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    }, registry);
    return {
        ...usage,
        billingUnits: cost.billingUnits,
        ...(cost.cost !== undefined ? { cost: cost.cost } : {}),
        ...(cost.costUSD !== undefined ? { costUSD: cost.costUSD } : {}),
        costBreakdown: cost.costBreakdown,
        estimated: cost.estimated,
    };
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
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const cachedReadTokens = usage?.input_tokens_details?.cached_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        0;
    const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ??
        usage?.completion_tokens_details?.reasoning_tokens;
    const counts = {
        billedInputTokens: Math.max(inputTokens - cachedReadTokens, 0),
        cachedReadTokens,
        cachedTokens: cachedReadTokens,
        inputTokens,
        outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    };
    if (reasoningTokens !== undefined) {
        counts.reasoningTokens = reasoningTokens;
    }
    return counts;
}
export function geminiUsageToCanonical(usage) {
    const inputTokens = usage?.promptTokenCount ?? 0;
    const cachedTokens = usage?.cachedContentTokenCount ?? 0;
    const counts = {
        billedInputTokens: Math.max(inputTokens - cachedTokens, 0),
        cachedReadTokens: cachedTokens,
        cachedTokens,
        inputTokens,
        outputTokens: usage?.candidatesTokenCount ?? 0,
    };
    if (usage?.thoughtsTokenCount !== undefined) {
        counts.reasoningTokens = usage.thoughtsTokenCount;
    }
    return counts;
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
function costForTokens(tokens, pricePerMillion) {
    return (tokens / 1_000_000) * pricePerMillion;
}
function costForCharacters(characters, pricePerMillion) {
    return (characters / 1_000_000) * pricePerMillion;
}
function costForSeconds(seconds, pricePerSecond) {
    return seconds * pricePerSecond;
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
    if (model.kind !== undefined) {
        entry.kind = model.kind;
    }
    if (model.speechPrices !== undefined) {
        entry.speechPrices = model.speechPrices;
    }
    if (model.supportedOutputModalities !== undefined) {
        entry.supportedOutputModalities = model.supportedOutputModalities;
    }
    return entry;
}
function buildSpeechBillingUnits(input) {
    return {
        ...(input.audioInputTokens !== undefined ? { audioInputTokens: input.audioInputTokens } : {}),
        ...(input.audioOutputTokens !== undefined ? { audioOutputTokens: input.audioOutputTokens } : {}),
        ...(input.inputAudioSeconds !== undefined ? { inputAudioSeconds: input.inputAudioSeconds } : {}),
        ...(input.inputCharacters !== undefined ? { inputCharacters: input.inputCharacters } : {}),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputAudioSeconds !== undefined ? { outputAudioSeconds: input.outputAudioSeconds } : {}),
        ...(input.outputCharacters !== undefined ? { outputCharacters: input.outputCharacters } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    };
}
function addSpeechCostLine(items, input) {
    if (input.quantity === undefined ||
        input.rateUSD === undefined ||
        input.quantity <= 0 ||
        input.rateUSD < 0) {
        return;
    }
    const amountUSD = input.unit === 'text_input_token' ||
        input.unit === 'text_output_token' ||
        input.unit === 'audio_input_token' ||
        input.unit === 'audio_output_token'
        ? costForTokens(input.quantity, input.rateUSD)
        : input.unit === 'character'
            ? costForCharacters(input.quantity, input.rateUSD)
            : input.unit === 'audio_second'
                ? costForSeconds(input.quantity, input.rateUSD)
                : input.quantity * input.rateUSD;
    items.push({
        amountUSD: roundUsd(amountUSD),
        estimated: input.estimated,
        label: input.label,
        quantity: input.quantity,
        rateUSD: input.rateUSD,
        unit: input.unit,
    });
}
