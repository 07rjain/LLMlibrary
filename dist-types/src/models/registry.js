import { ProviderCapabilityError } from '../errors.js';
import { isProductionRuntime } from '../runtime.js';
import { defaultModelPrices } from './prices.js';
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
    models = new Map();
    now;
    onWarning;
    constructor(seed = defaultModelPrices, options = {}) {
        this.now = options.now ?? (() => new Date());
        this.onWarning = options.onWarning ?? ((message) => console.warn(message));
        for (const [id, model] of Object.entries(seed)) {
            this.models.set(id, { ...model, id });
        }
        if (options.emitStalenessWarning ?? !isProductionRuntime()) {
            this.warnOnStalePrices();
        }
    }
    assertCapability(modelId, capability, featureLabel) {
        const model = this.get(modelId);
        if (!model[capability]) {
            const label = featureLabel ?? capability.replace('supports', '').toLowerCase();
            throw new ProviderCapabilityError(`Model "${modelId}" does not support ${label}.`, {
                model: modelId,
                provider: model.provider,
            });
        }
        return model;
    }
    get(modelId) {
        const model = this.models.get(modelId);
        if (!model) {
            throw new ProviderCapabilityError(`Unknown model "${modelId}".`, {
                model: modelId,
            });
        }
        return { ...model };
    }
    isSupported(modelId) {
        return this.models.has(modelId);
    }
    list() {
        return [...this.models.values()]
            .map((model) => ({ ...model }))
            .sort((left, right) => left.id.localeCompare(right.id));
    }
    register(model) {
        this.models.set(model.id, { ...model });
        return this.get(model.id);
    }
    updatePrices(overrides) {
        for (const [modelId, override] of Object.entries(overrides)) {
            const current = this.get(modelId);
            this.models.set(modelId, {
                ...current,
                ...override,
            });
        }
    }
    warnOnStalePrices() {
        const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
        const now = this.now().getTime();
        for (const model of this.models.values()) {
            const lastUpdated = Date.parse(model.lastUpdated);
            if (Number.isNaN(lastUpdated)) {
                continue;
            }
            if (now - lastUpdated > ninetyDaysMs) {
                this.onWarning(`Model price metadata for "${model.id}" is older than 90 days (${model.lastUpdated}).`);
            }
        }
    }
}
