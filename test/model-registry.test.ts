import { describe, expect, it, vi } from 'vitest';

import { ProviderCapabilityError } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';

describe('ModelRegistry', () => {
  it('lists seeded models', () => {
    const registry = new ModelRegistry();

    expect(registry.list().length).toBe(13);
    expect(registry.isSupported('claude-sonnet-4-6')).toBe(true);
  });

  it('returns a model and validates capabilities', () => {
    const registry = new ModelRegistry();

    expect(registry.get('gpt-4o').provider).toBe('openai');
    expect(
      registry.assertCapability('gpt-4o', 'supportsTools', 'tool calling').id,
    ).toBe('gpt-4o');
    expect(() =>
      registry.assertCapability('gpt-5.4-nano', 'supportsVision', 'vision'),
    ).toThrow(ProviderCapabilityError);
    expect(registry.assertModelKind('gemini-embedding-2', 'embedding').kind).toBe(
      'embedding',
    );
  });

  it('defaults legacy models to completion kind and rejects mismatched kinds', () => {
    const registry = new ModelRegistry();

    expect(registry.get('gpt-4o').kind).toBe('completion');
    expect(() => registry.assertModelKind('gpt-4o', 'embedding')).toThrow(
      ProviderCapabilityError,
    );
  });

  it('throws for unknown models', () => {
    const registry = new ModelRegistry();

    expect(() => registry.get('missing-model')).toThrow(ProviderCapabilityError);
  });

  it('registers custom models and updates prices', () => {
    const registry = new ModelRegistry();

    registry.register({
      contextWindow: 64000,
      id: 'custom-model',
      inputPrice: 1,
      lastUpdated: '2026-04-15',
      outputPrice: 2,
      provider: 'mock',
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false,
    });
    registry.updatePrices({
      'custom-model': {
        inputPrice: 1.5,
      },
    });

    expect(registry.get('custom-model').inputPrice).toBe(1.5);
  });

  it('warns when price metadata is stale', () => {
    const warning = vi.fn();
    new ModelRegistry(
      {
        stale: {
          contextWindow: 1000,
          inputPrice: 1,
          lastUpdated: '2025-01-01',
          outputPrice: 2,
          provider: 'mock',
          supportsStreaming: true,
          supportsTools: true,
          supportsVision: false,
        },
      },
      {
        emitStalenessWarning: true,
        now: () => new Date('2026-04-15T00:00:00Z'),
        onWarning: warning,
      },
    );

    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid lastUpdated values when checking staleness', () => {
    const warning = vi.fn();
    new ModelRegistry(
      {
        invalid: {
          contextWindow: 1000,
          inputPrice: 1,
          lastUpdated: 'not-a-date',
          outputPrice: 2,
          provider: 'mock',
          supportsStreaming: true,
          supportsTools: true,
          supportsVision: false,
        },
      },
      {
        emitStalenessWarning: true,
        now: () => new Date('2026-04-15T00:00:00Z'),
        onWarning: warning,
      },
    );

    expect(warning).not.toHaveBeenCalled();
  });
});
