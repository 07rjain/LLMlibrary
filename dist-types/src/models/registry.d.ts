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
export declare class ModelRegistry {
    private readonly models;
    private readonly now;
    private readonly onWarning;
    constructor(seed?: Record<string, Omit<ModelInfo, 'id'>>, options?: ModelRegistryOptions);
    assertCapability(modelId: string, capability: ModelCapability, featureLabel?: string): ModelInfo;
    assertModelKind(modelId: string, kind: NonNullable<ModelInfo['kind']>): ModelInfo;
    get(modelId: string): ModelInfo;
    isSupported(modelId: string): boolean;
    list(): ModelInfo[];
    register(model: ModelInfo): ModelInfo;
    updatePrices(overrides: ModelPriceOverrides): void;
    private warnOnStalePrices;
}
//# sourceMappingURL=registry.d.ts.map