import { ProviderCapabilityError } from 'unified-llm-client/errors';
import { isProductionRuntime } from '../runtime.js';

import { defaultModelPrices } from './prices.js';

import type { ModelCapability, ModelInfo } from '../types.js';

const MODEL_KINDS = [
  'completion',
  'embedding',
  'speech',
  'transcription',
] as const;
const MODEL_PROVIDERS = [
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
const INPUT_MODALITIES = [
  'audio',
  'document',
  'image',
  'text',
  'video',
] as const;
const OUTPUT_MODALITIES = ['audio', 'text'] as const;
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const SPEECH_PRICE_FIELDS = [
  'audioInputTokenPrice',
  'audioOutputTokenPrice',
  'characterInputPrice',
  'characterOutputPrice',
  'inputAudioSecondPrice',
  'outputAudioSecondPrice',
  'requestPrice',
  'textInputTokenPrice',
  'textOutputTokenPrice',
] as const;
const MODEL_OVERRIDE_FIELDS = [
  'cacheReadPrice',
  'cacheWritePrice',
  'contextWindow',
  'embeddingDimensions',
  'inputPrice',
  'kind',
  'lastUpdated',
  'maxInputTokens',
  'outputPrice',
  'speechPrices',
  'supportedInputModalities',
  'supportedOutputModalities',
  'supportedReasoningEfforts',
  'supportsJsonObjectOutput',
  'supportsJsonSchemaOutput',
  'supportsStreaming',
  'supportsStructuredOutputStreaming',
  'supportsTools',
  'supportsVision',
] as const;

/** Runtime price overrides keyed by model id. */
export interface ModelPriceOverrides {
  [modelId: string]: Partial<Omit<ModelInfo, 'id' | 'provider'>>;
}

/** Options for the shared model registry. */
export interface ModelRegistryOptions {
  emitStalenessWarning?: boolean;
  now?: () => Date;
  onWarning?: (message: string) => void;
}

/**
 * Stores model capability and pricing metadata used by adapters, budget guards,
 * and cost estimation.
 *
 * @example
 * ```ts
 * const registry = new ModelRegistry();
 * registry.assertCapability('gpt-4o', 'supportsTools', 'tool calling');
 * registry.updatePrices({
 *   'gpt-4o': { inputPrice: 4.5, outputPrice: 18 },
 * });
 * ```
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelInfo>();
  private readonly now: () => Date;
  private readonly onWarning: (message: string) => void;

  constructor(
    seed: Record<string, Omit<ModelInfo, 'id'>> = defaultModelPrices,
    options: ModelRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onWarning = options.onWarning ?? ((message) => console.warn(message));

    const isDefaultSeed = seed === defaultModelPrices;
    const validatedModels = Object.entries(seed).map(([id, model]) => {
      const modelInfo = normalizeModelInfo({ ...model, id });
      assertValidModelInfo(modelInfo, false);
      return [
        id,
        isDefaultSeed
          ? withBuiltInStructuredOutputDefaults(modelInfo)
          : modelInfo,
      ] as const;
    });
    for (const [id, modelInfo] of validatedModels) {
      this.models.set(id, modelInfo);
    }

    if (options.emitStalenessWarning ?? !isProductionRuntime()) {
      this.warnOnStalePrices();
    }
  }

  assertCapability(
    modelId: string,
    capability: ModelCapability,
    featureLabel?: string,
  ): ModelInfo {
    const model = this.get(modelId);
    if (!model[capability]) {
      const label =
        featureLabel ?? capability.replace('supports', '').toLowerCase();
      throw new ProviderCapabilityError(
        `Model "${modelId}" does not support ${label}.`,
        {
          model: modelId,
          provider: model.provider,
        },
      );
    }

    return model;
  }

  assertModelKind(
    modelId: string,
    kind: NonNullable<ModelInfo['kind']>,
  ): ModelInfo {
    const model = this.get(modelId);
    const actualKind = model.kind ?? 'completion';
    if (actualKind !== kind) {
      throw new ProviderCapabilityError(
        `Model "${modelId}" is a ${actualKind} model and cannot be used for ${kind} requests.`,
        {
          model: modelId,
          provider: model.provider,
        },
      );
    }

    return model;
  }

  get(modelId: string): ModelInfo {
    const model = this.models.get(modelId);
    if (!model) {
      throw new ProviderCapabilityError(`Unknown model "${modelId}".`, {
        model: modelId,
      });
    }

    return cloneModelInfo(normalizeModelInfo({ ...model }));
  }

  isSupported(modelId: string): boolean {
    return this.models.has(modelId);
  }

  list(): ModelInfo[] {
    return [...this.models.values()]
      .map((model) => cloneModelInfo(normalizeModelInfo({ ...model })))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  register(model: ModelInfo): ModelInfo {
    assertValidModelInfo(model, true);
    const normalized = cloneModelInfo(normalizeModelInfo(model));
    this.models.set(normalized.id, normalized);
    return this.get(normalized.id);
  }

  updatePrices(overrides: ModelPriceOverrides): void {
    if (!isPlainObject(overrides)) {
      throw modelValidationError('overrides', 'plain_object', overrides);
    }

    const prospective = new Map<string, ModelInfo>();
    for (const [modelId, override] of Object.entries(overrides)) {
      if (!isPlainObject(override)) {
        throw modelValidationError(
          `overrides.${modelId}`,
          'plain_object',
          override,
          modelId,
        );
      }
      for (const field of Object.keys(override)) {
        if (!(MODEL_OVERRIDE_FIELDS as readonly string[]).includes(field)) {
          throw modelValidationError(
            `overrides.${modelId}.${field}`,
            'supported_override_field',
            (override as Record<string, unknown>)[field],
            modelId,
          );
        }
      }
      const current = this.get(modelId);
      const merged = {
        ...normalizeModelInfo(current),
        ...override,
        kind: override.kind ?? current.kind ?? 'completion',
      } as ModelInfo;
      assertValidModelInfo(merged, false);
      prospective.set(modelId, cloneModelInfo(merged));
    }

    for (const [modelId, model] of prospective) {
      this.models.set(modelId, model);
    }
  }

  private warnOnStalePrices(): void {
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const now = this.now().getTime();

    for (const model of this.models.values()) {
      const lastUpdated = Date.parse(model.lastUpdated);
      if (Number.isNaN(lastUpdated)) {
        continue;
      }

      if (now - lastUpdated > ninetyDaysMs) {
        this.onWarning(
          `Model price metadata for "${model.id}" is older than 90 days (${model.lastUpdated}).`,
        );
      }
    }
  }
}

function normalizeModelInfo(model: ModelInfo): ModelInfo {
  return {
    ...model,
    kind: model.kind ?? 'completion',
  };
}

function cloneModelInfo(model: ModelInfo): ModelInfo {
  return {
    ...model,
    ...(model.embeddingDimensions
      ? {
          embeddingDimensions: {
            ...model.embeddingDimensions,
            ...(model.embeddingDimensions.recommended
              ? { recommended: [...model.embeddingDimensions.recommended] }
              : {}),
          },
        }
      : {}),
    ...(model.speechPrices ? { speechPrices: { ...model.speechPrices } } : {}),
    ...(model.supportedInputModalities
      ? { supportedInputModalities: [...model.supportedInputModalities] }
      : {}),
    ...(model.supportedOutputModalities
      ? { supportedOutputModalities: [...model.supportedOutputModalities] }
      : {}),
    ...(model.supportedReasoningEfforts
      ? { supportedReasoningEfforts: [...model.supportedReasoningEfforts] }
      : {}),
  };
}

function assertValidModelInfo(
  model: unknown,
  requireExplicitKind: boolean,
): asserts model is ModelInfo {
  if (!isPlainObject(model)) {
    throw modelValidationError('model', 'plain_object', model);
  }

  assertNonEmptyString(model.id, 'id');
  assertAllowedString(model.provider, MODEL_PROVIDERS, 'provider', model.id);
  const id = model.id;
  const provider = model.provider as ModelInfo['provider'];
  if (requireExplicitKind && model.kind === undefined) {
    throw modelValidationError('kind', 'required', model.kind, id, provider);
  }
  if (model.kind !== undefined) {
    assertAllowedString(model.kind, MODEL_KINDS, 'kind', id, provider);
  }
  const kind = (model.kind ?? 'completion') as NonNullable<ModelInfo['kind']>;

  assertNonNegativePrice(model.inputPrice, 'inputPrice', id, provider);
  assertNonNegativePrice(model.outputPrice, 'outputPrice', id, provider);
  if (model.cacheReadPrice !== undefined) {
    assertNonNegativePrice(
      model.cacheReadPrice,
      'cacheReadPrice',
      id,
      provider,
    );
  }
  if (model.cacheWritePrice !== undefined) {
    assertNonNegativePrice(
      model.cacheWritePrice,
      'cacheWritePrice',
      id,
      provider,
    );
  }

  assertContextWindow(model.contextWindow, id, provider);
  if (model.maxInputTokens !== undefined) {
    assertPositiveInteger(model.maxInputTokens, 'maxInputTokens', id, provider);
  }
  assertDate(model.lastUpdated, id, provider);

  for (const option of [
    'supportsStreaming',
    'supportsTools',
    'supportsVision',
  ] as const) {
    if (typeof model[option] !== 'boolean') {
      throw modelValidationError(
        option,
        'boolean',
        model[option],
        id,
        provider,
      );
    }
  }
  for (const option of [
    'supportsJsonObjectOutput',
    'supportsJsonSchemaOutput',
    'supportsStructuredOutputStreaming',
  ] as const) {
    if (model[option] !== undefined && typeof model[option] !== 'boolean') {
      throw modelValidationError(
        option,
        'boolean',
        model[option],
        id,
        provider,
      );
    }
  }

  if (model.supportedInputModalities !== undefined) {
    assertStringArray(
      model.supportedInputModalities,
      INPUT_MODALITIES,
      'supportedInputModalities',
      id,
      provider,
    );
  } else if (kind !== 'completion') {
    throw modelValidationError(
      'supportedInputModalities',
      'required_for_model_kind',
      undefined,
      id,
      provider,
    );
  }
  if (model.supportedOutputModalities !== undefined) {
    assertStringArray(
      model.supportedOutputModalities,
      OUTPUT_MODALITIES,
      'supportedOutputModalities',
      id,
      provider,
    );
  } else if (kind === 'speech' || kind === 'transcription') {
    throw modelValidationError(
      'supportedOutputModalities',
      'required_for_model_kind',
      undefined,
      id,
      provider,
    );
  }

  if (model.supportedReasoningEfforts !== undefined) {
    assertStringArray(
      model.supportedReasoningEfforts,
      REASONING_EFFORTS,
      'supportedReasoningEfforts',
      id,
      provider,
      true,
    );
  }
  if (model.embeddingDimensions !== undefined) {
    assertEmbeddingDimensions(model.embeddingDimensions, id, provider);
  }
  if (model.speechPrices !== undefined) {
    assertSpeechPrices(model.speechPrices, id, provider);
  }
}

function assertContextWindow(
  value: unknown,
  model: string,
  provider: ModelInfo['provider'],
): void {
  const isValid = Number.isSafeInteger(value) && (value as number) > 0;
  if (!isValid) {
    throw modelValidationError(
      'contextWindow',
      'finite_positive_safe_integer',
      value,
      model,
      provider,
    );
  }
}

function assertEmbeddingDimensions(
  value: unknown,
  model: string,
  provider: ModelInfo['provider'],
): void {
  if (!isPlainObject(value)) {
    throw modelValidationError(
      'embeddingDimensions',
      'plain_object',
      value,
      model,
      provider,
    );
  }
  assertPositiveInteger(
    value.default,
    'embeddingDimensions.default',
    model,
    provider,
  );
  const defaultDimension = value.default as number;
  if (value.min !== undefined) {
    assertPositiveInteger(
      value.min,
      'embeddingDimensions.min',
      model,
      provider,
    );
  }
  if (value.max !== undefined) {
    assertPositiveInteger(
      value.max,
      'embeddingDimensions.max',
      model,
      provider,
    );
  }
  if (
    (typeof value.min === 'number' && defaultDimension < value.min) ||
    (typeof value.max === 'number' && defaultDimension > value.max) ||
    (typeof value.min === 'number' &&
      typeof value.max === 'number' &&
      value.min > value.max)
  ) {
    throw modelValidationError(
      'embeddingDimensions',
      'ordered_min_default_max',
      undefined,
      model,
      provider,
    );
  }
  if (value.recommended !== undefined) {
    if (
      !Array.isArray(value.recommended) ||
      value.recommended.length === 0 ||
      value.recommended.some(
        (dimension) =>
          !Number.isSafeInteger(dimension) ||
          dimension <= 0 ||
          (typeof value.min === 'number' && dimension < value.min) ||
          (typeof value.max === 'number' && dimension > value.max),
      )
    ) {
      throw modelValidationError(
        'embeddingDimensions.recommended',
        'positive_safe_integers_within_bounds',
        value.recommended,
        model,
        provider,
      );
    }
  }
}

function assertSpeechPrices(
  value: unknown,
  model: string,
  provider: ModelInfo['provider'],
): void {
  if (!isPlainObject(value)) {
    throw modelValidationError(
      'speechPrices',
      'plain_object',
      value,
      model,
      provider,
    );
  }
  for (const [field, price] of Object.entries(value)) {
    if (!(SPEECH_PRICE_FIELDS as readonly string[]).includes(field)) {
      throw modelValidationError(
        `speechPrices.${field}`,
        'supported_price_unit',
        price,
        model,
        provider,
      );
    }
    assertNonNegativePrice(price, `speechPrices.${field}`, model, provider);
  }
}

function assertStringArray(
  value: unknown,
  allowed: readonly string[],
  option: string,
  model: string,
  provider: ModelInfo['provider'],
  allowEmpty = false,
): void {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry))
  ) {
    throw modelValidationError(
      option,
      'non_empty_supported_values',
      value,
      model,
      provider,
    );
  }
}

function assertNonNegativePrice(
  value: unknown,
  option: string,
  model?: string,
  provider?: ModelInfo['provider'],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw modelValidationError(
      option,
      'finite_non_negative_number',
      value,
      model,
      provider,
    );
  }
}

function assertPositiveInteger(
  value: unknown,
  option: string,
  model?: string,
  provider?: ModelInfo['provider'],
): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw modelValidationError(
      option,
      'finite_positive_safe_integer',
      value,
      model,
      provider,
    );
  }
}

function assertNonEmptyString(
  value: unknown,
  option: string,
  model?: string,
  provider?: ModelInfo['provider'],
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw modelValidationError(
      option,
      'non_empty_string',
      value,
      model,
      provider,
    );
  }
}

function assertAllowedString(
  value: unknown,
  allowed: readonly string[],
  option: string,
  model?: string,
  provider?: ModelInfo['provider'],
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw modelValidationError(
      option,
      'supported_value',
      value,
      model,
      provider,
      allowed,
    );
  }
}

function assertDate(
  value: unknown,
  model: string,
  provider: ModelInfo['provider'],
): void {
  const parsed =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00Z`)
      : undefined;
  if (
    !parsed ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw modelValidationError(
      'lastUpdated',
      'yyyy_mm_dd',
      value,
      model,
      provider,
    );
  }
}

function modelValidationError(
  option: string,
  constraint: string,
  value: unknown,
  model?: string,
  provider?: unknown,
  allowed?: readonly string[],
): ProviderCapabilityError {
  return new ProviderCapabilityError(
    `Invalid model registry option "${option}".`,
    {
      details: {
        ...(allowed ? { allowed } : {}),
        constraint,
        option,
        ...(value !== undefined ? { value: safeDetailValue(value) } : {}),
      },
      ...(model ? { model } : {}),
      ...(typeof provider === 'string' &&
      (MODEL_PROVIDERS as readonly string[]).includes(provider)
        ? { provider: provider as ModelInfo['provider'] }
        : {}),
      statusCode: 400,
    },
  );
}

function safeDetailValue(value: unknown): unknown {
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

function withBuiltInStructuredOutputDefaults(model: ModelInfo): ModelInfo {
  if ((model.kind ?? 'completion') !== 'completion') {
    return model;
  }

  switch (model.provider) {
    case 'anthropic':
      return {
        ...model,
        supportsJsonSchemaOutput: model.supportsJsonSchemaOutput ?? true,
        supportsStructuredOutputStreaming:
          model.supportsStructuredOutputStreaming ?? true,
      };
    case 'google':
    case 'openai':
      return {
        ...model,
        supportsJsonObjectOutput: model.supportsJsonObjectOutput ?? true,
        supportsJsonSchemaOutput: model.supportsJsonSchemaOutput ?? true,
        supportsStructuredOutputStreaming:
          model.supportsStructuredOutputStreaming ?? true,
      };
    default:
      return model;
  }
}
