import { ProviderCapabilityError } from 'unified-llm-client/errors';

import type { ModelRegistry } from 'unified-llm-client/models';
import type {
  CanonicalMessage,
  CanonicalProvider,
  CanonicalTool,
  CanonicalToolChoice,
} from './types.js';

export interface RouterContext {
  maxTokens: number;
  messages: CanonicalMessage[];
  requestedModel?: string;
  requestedProvider?: CanonicalProvider;
  sessionId?: string;
  system?: string;
  temperature?: number;
  tenantId?: string;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

export interface ModelRouteTarget {
  model: string;
  name?: string;
  provider?: CanonicalProvider;
}

export interface WeightedRouteVariant extends ModelRouteTarget {
  weight: number;
}

export interface RouterContextFilter {
  hasTools?: boolean;
  model?: string;
  provider?: CanonicalProvider;
  sessionId?: string;
  tenantId?: string;
}

export type RouterMatch = RouterContextFilter | ((context: RouterContext) => boolean);

export interface ModelRouteRule {
  fallback?: Array<ModelRouteTarget | string>;
  match?: RouterMatch;
  name?: string;
  target?: ModelRouteTarget | string;
  variants?: WeightedRouteVariant[];
}

export interface ModelRouterOptions {
  rules?: ModelRouteRule[];
  seed?: string;
}

export interface ModelRouterResolveOptions {
  defaultModel?: string;
  defaultProvider?: CanonicalProvider;
  modelRegistry: ModelRegistry;
}

export interface ResolvedRouteAttempt {
  decision: string;
  model: string;
  provider?: CanonicalProvider;
}

export interface ResolvedModelRoute {
  attempts: ResolvedRouteAttempt[];
  decision: string;
  ruleName?: string;
}

const ROUTE_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'mistral',
  'cohere',
  'groq',
  'bedrock',
  'azure-openai',
  'ollama',
  'mock',
] as const;

export class ModelRouter {
  private readonly rules: ModelRouteRule[];
  private readonly seed: string;

  constructor(options: ModelRouterOptions = {}) {
    this.rules = snapshotRules(options.rules ?? []);
    this.seed = options.seed ?? 'default';
  }

  resolve(
    context: RouterContext,
    options: ModelRouterResolveOptions,
  ): ResolvedModelRoute {
    const matchedRule = this.rules.find((rule) => matchesRule(rule, context));
    const attempts: ResolvedRouteAttempt[] = [];

    if (!matchedRule) {
      const directAttempt = buildDirectAttempt(context, options);
      return {
        attempts: [directAttempt],
        decision: directAttempt.decision,
      };
    }

    const primaryTarget =
      selectPrimaryTarget(matchedRule, context, this.seed) ??
      buildDirectTarget(context, options);

    if (!primaryTarget) {
      throw new ProviderCapabilityError(
        `Model router rule "${matchedRule.name ?? 'unnamed'}" matched, but no target model was available.`,
      );
    }

    attempts.push(
      normalizeRuleAttempt(
        primaryTarget,
        options.modelRegistry,
        buildPrimaryDecision(matchedRule, primaryTarget),
      ),
    );

    for (const [index, fallbackTarget] of (matchedRule.fallback ?? []).entries()) {
      attempts.push(
        normalizeRuleAttempt(
          fallbackTarget,
          options.modelRegistry,
          buildFallbackDecision(matchedRule, fallbackTarget, index),
        ),
      );
    }

    return {
      attempts,
      decision: attempts[0]?.decision ?? 'unresolved',
      ...(matchedRule.name ? { ruleName: matchedRule.name } : {}),
    };
  }
}

function matchesRule(rule: ModelRouteRule, context: RouterContext): boolean {
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

function selectPrimaryTarget(
  rule: ModelRouteRule,
  context: RouterContext,
  seed: string,
): ModelRouteTarget | string | undefined {
  if (rule.variants && rule.variants.length > 0) {
    return selectWeightedVariant(rule, context, seed);
  }

  return rule.target;
}

function selectWeightedVariant(
  rule: ModelRouteRule,
  context: RouterContext,
  seed: string,
): WeightedRouteVariant {
  const totalWeight = rule.variants?.reduce((total, variant) => total + variant.weight, 0) ?? 0;
  if (!rule.variants || !Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new ProviderCapabilityError(
      `Model router rule "${rule.name ?? 'unnamed'}" has invalid variant weights.`,
      {
        details: {
          constraint: 'finite_positive_total',
          option: 'variants',
        },
        statusCode: 400,
      },
    );
  }

  const roll = hashStringToUnitInterval(buildSeedMaterial(rule, context, seed));
  let cursor = 0;

  for (const variant of rule.variants) {
    cursor += variant.weight / totalWeight;
    if (roll <= cursor) {
      return variant;
    }
  }

  return rule.variants.at(-1) as WeightedRouteVariant;
}

function buildSeedMaterial(
  rule: ModelRouteRule,
  context: RouterContext,
  seed: string,
): string {
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

function fingerprintMessages(messages: CanonicalMessage[]): string {
  return messages
    .slice(-3)
    .map((message) => `${message.role}:${summarizeContent(message.content)}`)
    .join('|')
    .slice(0, 240);
}

function summarizeContent(content: CanonicalMessage['content']): string {
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

function buildDirectAttempt(
  context: RouterContext,
  options: ModelRouterResolveOptions,
): ResolvedRouteAttempt {
  const directTarget = buildDirectTarget(context, options);
  if (!directTarget) {
    throw new ProviderCapabilityError(
      'No model was supplied. Set defaultModel on LLMClient or provide a model-router rule target.',
    );
  }

  const modelInfo = options.modelRegistry.get(directTarget.model);
  const provider =
    directTarget.provider ?? context.requestedProvider ?? options.defaultProvider ?? modelInfo.provider;

  if (provider !== modelInfo.provider) {
    throw new ProviderCapabilityError(
      `Model "${directTarget.model}" belongs to provider "${modelInfo.provider}", but route asked for "${provider}".`,
      {
        model: directTarget.model,
        provider,
      },
    );
  }

  return {
    decision: buildDirectDecision(context, directTarget.model),
    model: directTarget.model,
    provider,
  };
}

function buildDirectTarget(
  context: RouterContext,
  options: Pick<ModelRouterResolveOptions, 'defaultModel' | 'defaultProvider'>,
): ModelRouteTarget | undefined {
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

function normalizeRuleAttempt(
  target: ModelRouteTarget | string,
  modelRegistry: ModelRegistry,
  decision: string,
): ResolvedRouteAttempt {
  const normalizedTarget = typeof target === 'string' ? { model: target } : target;
  const modelInfo = modelRegistry.get(normalizedTarget.model);
  const provider = normalizedTarget.provider ?? modelInfo.provider;

  if (provider !== modelInfo.provider) {
    throw new ProviderCapabilityError(
      `Model "${normalizedTarget.model}" belongs to provider "${modelInfo.provider}", but route asked for "${provider}".`,
      {
        model: normalizedTarget.model,
        provider,
      },
    );
  }

  return {
    decision,
    model: normalizedTarget.model,
    provider,
  };
}

function buildDirectDecision(context: RouterContext, model: string): string {
  return context.requestedModel ? `requested:${model}` : `default:${model}`;
}

function buildPrimaryDecision(
  rule: ModelRouteRule,
  target: ModelRouteTarget | string,
): string {
  const normalizedTarget = typeof target === 'string' ? { model: target } : target;
  const label = normalizedTarget.name ?? normalizedTarget.model;

  if (rule.variants && rule.variants.length > 0) {
    return `rule:${rule.name ?? 'unnamed'}:variant:${label}`;
  }

  return `rule:${rule.name ?? 'unnamed'}:primary:${label}`;
}

function buildFallbackDecision(
  rule: ModelRouteRule,
  target: ModelRouteTarget | string,
  index: number,
): string {
  const normalizedTarget = typeof target === 'string' ? { model: target } : target;
  return `rule:${rule.name ?? 'unnamed'}:fallback:${index + 1}:${normalizedTarget.name ?? normalizedTarget.model}`;
}

function hashStringToUnitInterval(input: string): number {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return ((hash >>> 0) + 1) / 4294967297;
}

function snapshotRules(rules: unknown): ModelRouteRule[] {
  if (!Array.isArray(rules)) {
    throw routeValidationError('rules', 'array', rules);
  }

  return rules.map((rule, ruleIndex) => {
    const ruleOption = `rules[${ruleIndex}]`;
    if (!isPlainObject(rule)) {
      throw routeValidationError(ruleOption, 'plain_object', rule);
    }
    if (rule.name !== undefined) {
      assertRouteString(rule.name, `${ruleOption}.name`);
    }

    const snapshot: ModelRouteRule = {};
    if (rule.name !== undefined) {
      snapshot.name = rule.name as string;
    }
    if (rule.match !== undefined) {
      if (typeof rule.match === 'function') {
        snapshot.match = rule.match as (context: RouterContext) => boolean;
      } else if (isPlainObject(rule.match)) {
        snapshot.match = { ...rule.match } as RouterContextFilter;
      } else {
        throw routeValidationError(`${ruleOption}.match`, 'function_or_plain_object', rule.match);
      }
    }
    if (rule.target !== undefined) {
      snapshot.target = snapshotTarget(rule.target, `${ruleOption}.target`);
    }
    if (rule.fallback !== undefined) {
      if (!Array.isArray(rule.fallback)) {
        throw routeValidationError(`${ruleOption}.fallback`, 'array', rule.fallback);
      }
      snapshot.fallback = rule.fallback.map((target, index) =>
        snapshotTarget(target, `${ruleOption}.fallback[${index}]`),
      );
    }
    if (rule.variants !== undefined) {
      if (!Array.isArray(rule.variants) || rule.variants.length === 0) {
        throw routeValidationError(
          `${ruleOption}.variants`,
          'non_empty_array',
          rule.variants,
        );
      }
      let totalWeight = 0;
      snapshot.variants = rule.variants.map((variant, index) => {
        const option = `${ruleOption}.variants[${index}]`;
        if (!isPlainObject(variant)) {
          throw routeValidationError(option, 'plain_object', variant);
        }
        const target = snapshotTarget(variant, option) as ModelRouteTarget;
        const weight = variant.weight;
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
          throw routeValidationError(`${option}.weight`, 'finite_positive_number', weight);
        }
        totalWeight += weight;
        return { ...target, weight };
      });
      if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
        throw routeValidationError(
          `${ruleOption}.variants`,
          'finite_positive_total',
          totalWeight,
        );
      }
    }
    return snapshot;
  });
}

function snapshotTarget(value: unknown, option: string): ModelRouteTarget | string {
  if (typeof value === 'string') {
    assertRouteString(value, option);
    return value;
  }
  if (!isPlainObject(value)) {
    throw routeValidationError(option, 'model_string_or_plain_object', value);
  }
  assertRouteString(value.model, `${option}.model`);
  const target: ModelRouteTarget = { model: value.model };
  if (value.name !== undefined) {
    assertRouteString(value.name, `${option}.name`);
    target.name = value.name;
  }
  if (value.provider !== undefined) {
    if (
      typeof value.provider !== 'string' ||
      !(ROUTE_PROVIDERS as readonly string[]).includes(value.provider)
    ) {
      throw routeValidationError(
        `${option}.provider`,
        'supported_provider',
        value.provider,
      );
    }
    target.provider = value.provider as CanonicalProvider;
  }
  return target;
}

function assertRouteString(value: unknown, option: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw routeValidationError(option, 'non_empty_string', value);
  }
}

function routeValidationError(
  option: string,
  constraint: string,
  value: unknown,
): ProviderCapabilityError {
  return new ProviderCapabilityError(`Invalid model router option "${option}".`, {
    details: {
      constraint,
      option,
      ...(value !== undefined ? { value: safeRouteDetail(value) } : {}),
    },
    statusCode: 400,
  });
}

function safeRouteDetail(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
