import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../src/models/registry.js';
import {
  anthropicUsageToCanonical,
  calcCostUSD,
  formatCost,
  geminiUsageToCanonical,
  openaiUsageToCanonical,
  usageWithCost,
} from '../src/utils/cost.js';

describe('cost utilities', () => {
  const registry = new ModelRegistry();

  it('calculates cost for every launch model entry', () => {
    for (const model of registry.list()) {
      const cost = calcCostUSD(
        {
          cachedReadTokens: 100,
          cachedWriteTokens: 50,
          inputTokens: 1000,
          model: model.id,
          outputTokens: 500,
        },
        registry,
      );

      expect(cost).toBeGreaterThan(0);
    }
  });

  it('matches the exact pricing formula for every launch model entry', () => {
    for (const model of registry.list()) {
      const inputTokens = 2_000;
      const outputTokens = 750;
      const cachedReadTokens = 400;
      const cachedWriteTokens = 200;
      const expected =
        (inputTokens / 1_000_000) * model.inputPrice +
        (outputTokens / 1_000_000) * model.outputPrice +
        (cachedReadTokens / 1_000_000) * (model.cacheReadPrice ?? model.inputPrice * 0.1) +
        (cachedWriteTokens / 1_000_000) * (model.cacheWritePrice ?? model.inputPrice * 1.25);

      expect(
        calcCostUSD(
          {
            cachedReadTokens,
            cachedWriteTokens,
            inputTokens,
            model: model.id,
            outputTokens,
          },
          registry,
        ),
      ).toBeCloseTo(expected, 9);
    }
  });

  it('returns zero for unknown models', () => {
    expect(
      calcCostUSD({
        inputTokens: 1000,
        model: 'unknown-model',
        outputTokens: 500,
      }),
    ).toBe(0);
  });

  it('formats costs consistently', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.00234)).toBe('$0.0023');
    expect(formatCost(12.3456)).toBe('$12.35');
  });

  it('normalizes provider usage payloads', () => {
    expect(
      anthropicUsageToCanonical({
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 20,
        input_tokens: 100,
        output_tokens: 50,
      }),
    ).toEqual({
      cachedReadTokens: 20,
      cachedTokens: 60,
      cachedWriteTokens: 40,
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(
      openaiUsageToCanonical({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 25 },
        output_tokens: 50,
      }),
    ).toEqual({
      cachedReadTokens: 25,
      cachedTokens: 25,
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(
      openaiUsageToCanonical({
        completion_tokens: 20,
        prompt_tokens: 80,
        prompt_tokens_details: { cached_tokens: 10 },
      }),
    ).toEqual({
      cachedReadTokens: 10,
      cachedTokens: 10,
      inputTokens: 80,
      outputTokens: 20,
    });

    expect(
      geminiUsageToCanonical({
        cachedContentTokenCount: 12,
        candidatesTokenCount: 50,
        promptTokenCount: 100,
      }),
    ).toEqual({
      cachedTokens: 12,
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(anthropicUsageToCanonical(undefined)).toEqual({
      cachedReadTokens: 0,
      cachedTokens: 0,
      cachedWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(openaiUsageToCanonical(undefined)).toEqual({
      cachedReadTokens: 0,
      cachedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(geminiUsageToCanonical(undefined)).toEqual({
      cachedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('attaches formatted cost to usage metrics', () => {
    const model = registry.get('claude-sonnet-4-6');

    expect(
      usageWithCost(model, {
        cachedReadTokens: 20,
        cachedTokens: 60,
        cachedWriteTokens: 40,
        inputTokens: 100,
        outputTokens: 50,
      }),
    ).toMatchObject({
      cachedTokens: 60,
      cost: '$0.0012',
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('uses fallback cache pricing when a model does not define cache prices', () => {
    const gemini = registry.get('gemini-2.5-flash');

    expect(
      calcCostUSD(
        {
          cachedReadTokens: 100,
          cachedWriteTokens: 50,
          inputTokens: 1000,
          model: gemini.id,
          outputTokens: 500,
        },
        registry,
      ),
    ).toBeGreaterThan(0);

    expect(
      usageWithCost(gemini, {
        cachedReadTokens: 100,
        cachedTokens: 150,
        cachedWriteTokens: 50,
        inputTokens: 1000,
        outputTokens: 500,
      }).costUSD,
    ).toBeGreaterThan(0);
  });
});
