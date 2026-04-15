import { ProviderCapabilityError } from './errors.js';
export class ModelRouter {
    rules;
    seed;
    constructor(options = {}) {
        this.rules = [...(options.rules ?? [])];
        this.seed = options.seed ?? 'default';
    }
    resolve(context, options) {
        const matchedRule = this.rules.find((rule) => matchesRule(rule, context));
        const attempts = [];
        if (!matchedRule) {
            const directAttempt = buildDirectAttempt(context, options);
            return {
                attempts: [directAttempt],
                decision: directAttempt.decision,
            };
        }
        const primaryTarget = selectPrimaryTarget(matchedRule, context, this.seed) ??
            buildDirectTarget(context, options);
        if (!primaryTarget) {
            throw new ProviderCapabilityError(`Model router rule "${matchedRule.name ?? 'unnamed'}" matched, but no target model was available.`);
        }
        attempts.push(normalizeRuleAttempt(primaryTarget, options.modelRegistry, buildPrimaryDecision(matchedRule, primaryTarget)));
        for (const [index, fallbackTarget] of (matchedRule.fallback ?? []).entries()) {
            attempts.push(normalizeRuleAttempt(fallbackTarget, options.modelRegistry, buildFallbackDecision(matchedRule, fallbackTarget, index)));
        }
        return {
            attempts,
            decision: attempts[0]?.decision ?? 'unresolved',
            ...(matchedRule.name ? { ruleName: matchedRule.name } : {}),
        };
    }
}
function matchesRule(rule, context) {
    if (!rule.match) {
        return true;
    }
    if (typeof rule.match === 'function') {
        return rule.match(context);
    }
    if (rule.match.hasTools !== undefined) {
        const hasTools = Boolean(context.tools && context.tools.length > 0);
        if (hasTools !== rule.match.hasTools) {
            return false;
        }
    }
    if (rule.match.model !== undefined && context.requestedModel !== rule.match.model) {
        return false;
    }
    if (rule.match.provider !== undefined && context.requestedProvider !== rule.match.provider) {
        return false;
    }
    if (rule.match.sessionId !== undefined && context.sessionId !== rule.match.sessionId) {
        return false;
    }
    if (rule.match.tenantId !== undefined && context.tenantId !== rule.match.tenantId) {
        return false;
    }
    return true;
}
function selectPrimaryTarget(rule, context, seed) {
    if (rule.variants && rule.variants.length > 0) {
        return selectWeightedVariant(rule, context, seed);
    }
    return rule.target;
}
function selectWeightedVariant(rule, context, seed) {
    const totalWeight = rule.variants?.reduce((total, variant) => total + variant.weight, 0) ?? 0;
    if (!rule.variants || totalWeight <= 0) {
        throw new ProviderCapabilityError(`Model router rule "${rule.name ?? 'unnamed'}" has invalid variant weights.`);
    }
    const roll = hashStringToUnitInterval(buildSeedMaterial(rule, context, seed));
    let cursor = 0;
    for (const variant of rule.variants) {
        cursor += variant.weight / totalWeight;
        if (roll <= cursor) {
            return variant;
        }
    }
    return rule.variants.at(-1);
}
function buildSeedMaterial(rule, context, seed) {
    return [
        seed,
        rule.name ?? '',
        context.tenantId ?? '',
        context.sessionId ?? '',
        context.requestedProvider ?? '',
        context.requestedModel ?? '',
        context.system ?? '',
        fingerprintMessages(context.messages),
    ].join('|');
}
function fingerprintMessages(messages) {
    return messages
        .slice(-3)
        .map((message) => `${message.role}:${summarizeContent(message.content)}`)
        .join('|')
        .slice(0, 240);
}
function summarizeContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .map((part) => {
        if (part.type === 'text') {
            return part.text;
        }
        if (part.type === 'tool_call') {
            return `${part.name}:${JSON.stringify(part.args)}`;
        }
        if (part.type === 'tool_result') {
            return `${part.name ?? ''}:${JSON.stringify(part.result)}`;
        }
        return part.type;
    })
        .join(' ');
}
function buildDirectAttempt(context, options) {
    const directTarget = buildDirectTarget(context, options);
    if (!directTarget) {
        throw new ProviderCapabilityError('No model was supplied. Set defaultModel on LLMClient or provide a model-router rule target.');
    }
    const modelInfo = options.modelRegistry.get(directTarget.model);
    const provider = directTarget.provider ?? context.requestedProvider ?? options.defaultProvider ?? modelInfo.provider;
    if (provider !== modelInfo.provider) {
        throw new ProviderCapabilityError(`Model "${directTarget.model}" belongs to provider "${modelInfo.provider}", but route asked for "${provider}".`, {
            model: directTarget.model,
            provider,
        });
    }
    return {
        decision: buildDirectDecision(context, directTarget.model),
        model: directTarget.model,
        provider,
    };
}
function buildDirectTarget(context, options) {
    const model = context.requestedModel ?? options.defaultModel;
    if (!model) {
        return undefined;
    }
    return {
        model,
        ...(context.requestedProvider ?? options.defaultProvider
            ? { provider: context.requestedProvider ?? options.defaultProvider }
            : {}),
    };
}
function normalizeRuleAttempt(target, modelRegistry, decision) {
    const normalizedTarget = typeof target === 'string' ? { model: target } : target;
    const modelInfo = modelRegistry.get(normalizedTarget.model);
    const provider = normalizedTarget.provider ?? modelInfo.provider;
    if (provider !== modelInfo.provider) {
        throw new ProviderCapabilityError(`Model "${normalizedTarget.model}" belongs to provider "${modelInfo.provider}", but route asked for "${provider}".`, {
            model: normalizedTarget.model,
            provider,
        });
    }
    return {
        decision,
        model: normalizedTarget.model,
        provider,
    };
}
function buildDirectDecision(context, model) {
    return context.requestedModel ? `requested:${model}` : `default:${model}`;
}
function buildPrimaryDecision(rule, target) {
    const normalizedTarget = typeof target === 'string' ? { model: target } : target;
    const label = normalizedTarget.name ?? normalizedTarget.model;
    if (rule.variants && rule.variants.length > 0) {
        return `rule:${rule.name ?? 'unnamed'}:variant:${label}`;
    }
    return `rule:${rule.name ?? 'unnamed'}:primary:${label}`;
}
function buildFallbackDecision(rule, target, index) {
    const normalizedTarget = typeof target === 'string' ? { model: target } : target;
    return `rule:${rule.name ?? 'unnamed'}:fallback:${index + 1}:${normalizedTarget.name ?? normalizedTarget.model}`;
}
function hashStringToUnitInterval(input) {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) + 1) / 4294967297;
}
