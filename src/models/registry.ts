import { ProviderCapabilityError } from '../errors.js';

import { defaultModelPrices } from './prices.js';

import type { ModelCapability, ModelInfo } from '../types.js';

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

    for (const [id, model] of Object.entries(seed)) {
      this.models.set(id, { ...model, id });
    }

    if (options.emitStalenessWarning ?? process.env.NODE_ENV !== 'production') {
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
      const label = featureLabel ?? capability.replace('supports', '').toLowerCase();
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

  get(modelId: string): ModelInfo {
    const model = this.models.get(modelId);
    if (!model) {
      throw new ProviderCapabilityError(`Unknown model "${modelId}".`, {
        model: modelId,
      });
    }

    return { ...model };
  }

  isSupported(modelId: string): boolean {
    return this.models.has(modelId);
  }

  list(): ModelInfo[] {
    return [...this.models.values()]
      .map((model) => ({ ...model }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  register(model: ModelInfo): ModelInfo {
    this.models.set(model.id, { ...model });
    return this.get(model.id);
  }

  updatePrices(overrides: ModelPriceOverrides): void {
    for (const [modelId, override] of Object.entries(overrides)) {
      const current = this.get(modelId);
      this.models.set(modelId, {
        ...current,
        ...override,
      });
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
