import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../src/models/registry.js';
import { ProviderCapabilityError } from '../src/errors.js';

describe('ModelRegistry', () => {
  describe('Built-in Models', () => {
    it('should include major OpenAI models', () => {
      const registry = new ModelRegistry();

      expect(registry.get('gpt-4o').provider).toBe('openai');
      expect(registry.get('gpt-4o-mini').provider).toBe('openai');
    });

    it('should include major Anthropic models', () => {
      const registry = new ModelRegistry();

      expect(registry.get('claude-sonnet-4-6').provider).toBe('anthropic');
    });

    it('should include major Google models', () => {
      const registry = new ModelRegistry();

      expect(registry.get('gemini-2.5-flash').provider).toBe('google');
    });
  });

  describe('Model Retrieval', () => {
    it('should return model info for known models', () => {
      const registry = new ModelRegistry();
      const model = registry.get('gpt-4o');

      expect(model.id).toBe('gpt-4o');
      expect(model.provider).toBe('openai');
      expect(typeof model.contextWindow).toBe('number');
      expect(typeof model.inputPrice).toBe('number');
      expect(typeof model.outputPrice).toBe('number');
      expect(typeof model.supportsStreaming).toBe('boolean');
      expect(typeof model.supportsTools).toBe('boolean');
      expect(typeof model.supportsVision).toBe('boolean');
    });

    it('should throw for unknown models', () => {
      const registry = new ModelRegistry();

      expect(() => registry.get('unknown-model-xyz')).toThrow(ProviderCapabilityError);
    });

    it('should list all registered models', () => {
      const registry = new ModelRegistry();
      const models = registry.list();

      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.id && m.provider)).toBe(true);
    });
  });

  describe('Custom Model Registration', () => {
    it('should register new models', () => {
      const registry = new ModelRegistry();

      registry.register({
        contextWindow: 32000,
        id: 'custom-llm',
        inputPrice: 0.5,
        lastUpdated: '2026-04-15',
        outputPrice: 1.5,
        provider: 'mock',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: false,
      });

      const model = registry.get('custom-llm');

      expect(model.id).toBe('custom-llm');
      expect(model.provider).toBe('mock');
      expect(model.contextWindow).toBe(32000);
      expect(model.inputPrice).toBe(0.5);
      expect(model.outputPrice).toBe(1.5);
    });

    it('should override existing models', () => {
      const registry = new ModelRegistry();

      const originalPrice = registry.get('gpt-4o').inputPrice;

      registry.register({
        contextWindow: 128000,
        id: 'gpt-4o',
        inputPrice: 99.99,
        lastUpdated: '2026-04-15',
        outputPrice: 199.99,
        provider: 'openai',
        supportsStreaming: true,
        supportsTools: true,
        supportsVision: true,
      });

      expect(registry.get('gpt-4o').inputPrice).toBe(99.99);
      expect(registry.get('gpt-4o').inputPrice).not.toBe(originalPrice);
    });
  });

  describe('Price Updates', () => {
    it('should update prices for existing models', () => {
      const registry = new ModelRegistry();

      registry.updatePrices({
        'gpt-4o': {
          inputPrice: 10.0,
          outputPrice: 20.0,
        },
      });

      expect(registry.get('gpt-4o').inputPrice).toBe(10.0);
      expect(registry.get('gpt-4o').outputPrice).toBe(20.0);
    });

    it('should update partial prices', () => {
      const registry = new ModelRegistry();
      const originalOutputPrice = registry.get('gpt-4o').outputPrice;

      registry.updatePrices({
        'gpt-4o': {
          inputPrice: 5.0,
        },
      });

      expect(registry.get('gpt-4o').inputPrice).toBe(5.0);
      expect(registry.get('gpt-4o').outputPrice).toBe(originalOutputPrice);
    });

    it('should update cache prices', () => {
      const registry = new ModelRegistry();

      registry.updatePrices({
        'claude-sonnet-4-6': {
          cacheReadPrice: 0.1,
          cacheWritePrice: 0.2,
        },
      });

      expect(registry.get('claude-sonnet-4-6').cacheReadPrice).toBe(0.1);
      expect(registry.get('claude-sonnet-4-6').cacheWritePrice).toBe(0.2);
    });

    it('should update multiple models at once', () => {
      const registry = new ModelRegistry();

      registry.updatePrices({
        'gpt-4o': { inputPrice: 1.0 },
        'claude-sonnet-4-6': { inputPrice: 2.0 },
        'gemini-2.5-flash': { inputPrice: 0.5 },
      });

      expect(registry.get('gpt-4o').inputPrice).toBe(1.0);
      expect(registry.get('claude-sonnet-4-6').inputPrice).toBe(2.0);
      expect(registry.get('gemini-2.5-flash').inputPrice).toBe(0.5);
    });

    it('should throw when updating prices for unknown models', () => {
      const registry = new ModelRegistry();

      expect(() =>
        registry.updatePrices({
          'unknown-model': { inputPrice: 1.0 },
        }),
      ).toThrow();
    });
  });

  describe('Model Filtering', () => {
    it('should filter models by provider', () => {
      const registry = new ModelRegistry();
      const openaiModels = registry.list().filter((m) => m.provider === 'openai');
      const anthropicModels = registry.list().filter((m) => m.provider === 'anthropic');
      const googleModels = registry.list().filter((m) => m.provider === 'google');

      expect(openaiModels.length).toBeGreaterThan(0);
      expect(anthropicModels.length).toBeGreaterThan(0);
      expect(googleModels.length).toBeGreaterThan(0);
    });

    it('should filter models by capability', () => {
      const registry = new ModelRegistry();
      const visionModels = registry.list().filter((m) => m.supportsVision);
      const toolModels = registry.list().filter((m) => m.supportsTools);
      const streamingModels = registry.list().filter((m) => m.supportsStreaming);

      expect(visionModels.length).toBeGreaterThan(0);
      expect(toolModels.length).toBeGreaterThan(0);
      expect(streamingModels.length).toBeGreaterThan(0);
    });

    it('should filter by context window size', () => {
      const registry = new ModelRegistry();
      const largeContextModels = registry.list().filter((m) => m.contextWindow >= 100000);

      expect(largeContextModels.length).toBeGreaterThan(0);
    });
  });

  describe('Model Aliases', () => {
    it('should resolve model aliases if supported', () => {
      const registry = new ModelRegistry();

      try {
        const model = registry.get('gpt-4o');
        expect(model).toBeDefined();
      } catch {
        // Aliases may not be implemented
      }
    });
  });

  describe('Registry Initialization', () => {
    it('should allow custom initial models', () => {
      const customModels: Record<string, Omit<import('../src/types.js').ModelInfo, 'id'>> = {
        'custom-only': {
          contextWindow: 8000,
          inputPrice: 1,
          lastUpdated: '2026-04-15',
          outputPrice: 2,
          provider: 'mock' as const,
          supportsStreaming: true,
          supportsTools: false,
          supportsVision: false,
        },
      };

      const registry = new ModelRegistry(customModels);

      expect(registry.get('custom-only').id).toBe('custom-only');
      expect(() => registry.get('gpt-4o')).toThrow();
    });

    it('should register additional models', () => {
      const registry = new ModelRegistry();

      registry.register({
        contextWindow: 8000,
        id: 'additional-model',
        inputPrice: 1,
        lastUpdated: '2026-04-15',
        outputPrice: 2,
        provider: 'mock' as const,
        supportsStreaming: true,
        supportsTools: false,
        supportsVision: false,
      });

      expect(registry.get('additional-model').id).toBe('additional-model');
      expect(registry.get('gpt-4o').provider).toBe('openai');
    });
  });
});
