import { describe, expect, it, vi } from 'vitest';

import { LLMClient } from '../src/client.js';
import { ProviderCapabilityError } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import {
  calcCostUSD,
  calcSpeechCostUSD,
  usageWithCost,
  anthropicUsageToCanonical,
} from '../src/utils/cost.js';
import type { ModelInfo } from '../src/types.js';

function registryAt(date: string): ModelRegistry {
  return new ModelRegistry(undefined, {
    emitStalenessWarning: false,
    now: () => new Date(date),
  });
}

describe('model lifecycle and effective pricing', () => {
  it.each([
    ['o3', '2026-12-11', 'gpt-6.1-sol'],
    ['tts-1', '2027-01-06', 'gpt-realtime-2.1-mini'],
    ['gpt-4o-mini-tts', '2027-01-06', 'gpt-realtime-2.1-mini'],
    ['gpt-4o', '2027-01-14', 'gpt-6-luna'],
    ['gpt-4o-mini-transcribe', '2027-02-26', 'gpt-transcribe'],
    ['gpt-5.4-nano', '2027-04-01', 'gpt-6-luna'],
  ])(
    'rejects %s at its exact shutdown boundary without silently migrating it',
    (id, date, replacement) => {
      const midnight = new Date(`${date}T00:00:00Z`);
      expect(
        registryAt(new Date(midnight.getTime() - 1).toISOString()).resolve(id)
          .id,
      ).toBe(id);
      const registry = registryAt(midnight.toISOString());
      expect(() => registry.resolve(id)).toThrow(replacement);
      // Metadata remains available for migration UIs and historical records.
      expect(registry.get(id).lifecycle?.shutdownDate).toBe(date);
    },
  );

  it('does not turn minimum availability guarantees or earliest dates into shutdowns', () => {
    const registry = registryAt('2027-05-08T00:00:00Z');
    expect(registry.resolve('claude-haiku-4-5').id).toBe('claude-haiku-4-5');
    expect(registry.resolve('gemini-3.1-flash-lite').id).toBe(
      'gemini-3.1-flash-lite',
    );
    expect(registry.resolve('gemini-2.5-flash-lite').lifecycle?.status).toBe(
      'active',
    );
  });

  it('resolves Google aliases only at the documented redirect dates', () => {
    const before = registryAt('2026-11-30T23:59:59.999Z');
    const after = registryAt('2026-12-01T00:00:00Z');
    expect(before.resolve('gemini-2.5-pro').id).toBe('gemini-2.5-pro');
    expect(before.resolve('gemini-2.5-flash').id).toBe('gemini-2.5-flash');
    expect(after.resolve('gemini-2.5-pro').id).toBe('gemini-3.8-flash');
    expect(after.resolve('gemini-2.5-flash').id).toBe('gemini-3.5-flash-lite');
    expect(before.resolve('gemini-3.5-flash').id).toBe('gemini-3.6-flash');
    expect(after.get('gemini-2.5-pro').id).toBe('gemini-2.5-pro');
  });

  it('rejects explicit retirements, cycles, missing targets, and incompatible redirects', () => {
    const registry = registryAt('2026-11-15T00:00:00Z');
    const base = registry.get('gpt-6-luna');
    const add = (
      id: string,
      replacementModel: string,
      extra: Partial<ModelInfo> = {},
    ) =>
      registry.register({
        ...base,
        id,
        ...extra,
        lifecycle: {
          status: 'redirected',
          redirectDate: '2026-01-01',
          replacementModel,
        },
      });
    registry.register({
      ...base,
      id: 'retired',
      lifecycle: { status: 'retired' },
    });
    expect(() => registry.resolve('retired')).toThrow('retired');
    add('cycle-a', 'cycle-b');
    add('cycle-b', 'cycle-a');
    expect(() => registry.resolve('cycle-a')).toThrow('cycle');
    add('missing', 'not-registered');
    expect(() => registry.resolve('missing')).toThrow('Unknown model');
    add('wrong-provider', 'claude-opus-5-5');
    expect(() => registry.resolve('wrong-provider')).toThrow(
      'provider and kind',
    );
    add('wrong-kind', 'gpt-transcribe');
    expect(() => registry.resolve('wrong-kind')).toThrow('provider and kind');
  });

  it.each([
    ['gemini-4-carbon', '2026-12-01', 2, 10, 4, 20],
    ['gemini-4-argon', '2026-12-01', 2, 10, 4, 20],
    ['gemini-3.8-flash', '2027-01-01', 0.75, 3.75, 1.5, 7.5],
    ['gemini-3.6-flash', '2027-01-01', 0.75, 3.75, 1.5, 7.5],
  ] as const)(
    'applies the announced %s price change at midnight UTC',
    (id, date, oldInput, oldOutput, newInput, newOutput) => {
      const midnight = new Date(`${date}T00:00:00Z`);
      expect(
        registryAt(new Date(midnight.getTime() - 1).toISOString()).get(id),
      ).toMatchObject({ inputPrice: oldInput, outputPrice: oldOutput });
      const registry = registryAt(midnight.toISOString());
      expect(registry.get(id)).toMatchObject({
        inputPrice: newInput,
        outputPrice: newOutput,
      });
      expect(
        calcCostUSD(
          { model: id, inputTokens: 1_000_000, outputTokens: 1_000_000 },
          registry,
        ),
      ).toBe(newInput + newOutput);
      expect(registry.list().find((model) => model.id === id)?.inputPrice).toBe(
        newInput,
      );
    },
  );

  it('fails before transport when promotional prices expire without a published successor', async () => {
    expect(
      registryAt('2026-11-30T23:59:59Z').resolve('gpt-5.6-sol').inputPrice,
    ).toBe(4);
    const registry = registryAt('2026-12-01T00:00:00Z');
    const fetchImplementation = vi.fn();
    const client = new LLMClient({
      modelRegistry: registry,
      openaiApiKey: 'test',
      fetchImplementation,
    });
    await expect(
      client.complete({ model: 'gpt-5.6-sol', messages: [] }),
    ).rejects.toThrow('Pricing');
    expect(() =>
      client.estimateRequest({ model: 'gpt-5.6-sol', messages: [] }),
    ).toThrow('Pricing');
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(registry.get('gpt-5.6-sol').inputPrice).toBe(4);
  });

  it('selects Haiku prompt-length pricing using uncached, cache-read, and cache-write tokens', () => {
    const registry = registryAt('2026-11-15T00:00:00Z');
    expect(
      calcCostUSD(
        {
          model: 'claude-haiku-5-5',
          inputTokens: 100_000,
          outputTokens: 1_000,
        },
        registry,
      ),
    ).toBe(0.0105);
    expect(
      calcCostUSD(
        {
          model: 'claude-haiku-5-5',
          inputTokens: 100_001,
          outputTokens: 1_000,
        },
        registry,
      ),
    ).toBe(0.0525005);
    const usage = usageWithCost(
      registry.get('claude-haiku-5-5'),
      anthropicUsageToCanonical({
        input_tokens: 1_000,
        cache_read_input_tokens: 99_000,
        cache_creation_input_tokens: 1,
        output_tokens: 1_000,
      }),
    );
    expect(usage.costUSD).toBeCloseTo(0.007950625, 9);
  });

  it('prices long OpenAI prompts using total input without double-counting cached tokens', () => {
    const registry = registryAt('2026-11-15T00:00:00Z');
    expect(
      calcCostUSD(
        { model: 'gpt-6.1-sol', inputTokens: 272_000, outputTokens: 1_000 },
        registry,
      ),
    ).toBe(0.554);
    expect(
      calcCostUSD(
        {
          model: 'gpt-6.1-sol',
          inputTokens: 272_001,
          billedInputTokens: 172_001,
          cachedReadTokens: 100_000,
          outputTokens: 1_000,
        },
        registry,
      ),
    ).toBe(0.723004);
    expect(
      calcCostUSD(
        { model: 'gemini-2.5-pro', inputTokens: 200_000, outputTokens: 1_000 },
        registry,
      ),
    ).toBe(0.26);
    expect(
      calcCostUSD(
        { model: 'gemini-2.5-pro', inputTokens: 200_001, outputTokens: 1_000 },
        registry,
      ),
    ).toBe(0.5150025);
  });

  it('keeps registry metadata isolated from caller mutations', () => {
    const registry = registryAt('2026-11-15T00:00:00Z');
    const model = registry.get('gemini-4-carbon');
    model.lifecycle!.status = 'retired';
    model.priceChanges![0]!.inputPrice = 0;
    const openai = registry.get('gpt-6.1-sol');
    openai.longContextPricing!.inputMultiplier = 0;
    expect(registry.resolve('gemini-4-carbon').lifecycle?.status).toBe(
      'active',
    );
    expect(registry.get('gemini-4-carbon').priceChanges![0]!.inputPrice).toBe(
      4,
    );
    expect(
      registry.get('gpt-6.1-sol').longContextPricing?.inputMultiplier,
    ).toBe(2);
  });

  it.each([
    { lifecycle: { status: 'unknown' } },
    { lifecycle: { status: 'deprecated', shutdownDate: '2027-02-30' } },
    { lifecycle: { status: 'redirected' } },
    { lifecycle: { status: 'active', redirectDate: '2026-01-01' } },
    {
      lifecycle: {
        status: 'deprecated',
        shutdownDate: '2027-01-01',
        earliestShutdownDate: '2027-01-01',
      },
    },
    { lifecycle: { status: 'active', ignored: true } },
    { priceChanges: {} },
    {
      priceChanges: [
        { effectiveFrom: '2027-01-01', inputPrice: -1, outputPrice: 2 },
      ],
    },
    {
      priceChanges: [
        { effectiveFrom: 'invalid', inputPrice: 1, outputPrice: 2 },
      ],
    },
    { priceChanges: [{ effectiveFrom: '2027-01-01', inputPrice: 1 }] },
    {
      priceChanges: [
        { effectiveFrom: '2027-01-01', inputPrice: 1, outputPrice: 2 },
        { effectiveFrom: '2027-01-01', inputPrice: 1, outputPrice: 2 },
      ],
    },
    {
      longContextPricing: {
        thresholdTokens: 0,
        inputMultiplier: 2,
        outputMultiplier: 2,
      },
    },
    {
      longContextPricing: {
        thresholdTokens: 1,
        inputMultiplier: 0,
        outputMultiplier: 2,
      },
    },
    {
      longContextPricing: {
        thresholdTokens: 1,
        inputMultiplier: Infinity,
        outputMultiplier: 2,
      },
    },
    { pricingExpiresAt: 'not-a-date' },
    { pricingSource: '' },
  ])(
    'rejects invalid lifecycle or price metadata atomically: %j',
    (override) => {
      const registry = registryAt('2026-11-15T00:00:00Z');
      const before = registry.get('gpt-6.1-sol');
      expect(() =>
        registry.register({ ...before, ...override } as ModelInfo),
      ).toThrow(ProviderCapabilityError);
      expect(() =>
        registry.updatePrices({
          'gpt-6-luna': { inputPrice: 0 },
          'gpt-6.1-sol': override,
        } as never),
      ).toThrow(ProviderCapabilityError);
      expect(registry.get('gpt-6.1-sol')).toEqual(before);
      expect(registry.get('gpt-6-luna').inputPrice).toBe(0.1);
    },
  );

  it('quotes redirected requests with the actual target model and target rates', () => {
    const client = new LLMClient({
      modelRegistry: registryAt('2026-12-01T00:00:00Z'),
    });
    const options = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
      maxTokens: 1_000,
    };
    expect(
      client.estimateRequest({ ...options, model: 'gemini-2.5-pro' }),
    ).toEqual(
      client.estimateRequest({ ...options, model: 'gemini-3.8-flash' }),
    );
    expect(
      calcCostUSD(
        { model: 'gemini-2.5-pro', inputTokens: 1_000, outputTokens: 1_000 },
        registryAt('2026-12-01T00:00:00Z'),
      ),
    ).toBe(0.0045);
  });

  it('uses the newer file-transcription default and its per-minute price', async () => {
    const fetchImplementation = vi.fn(
      async (_url: unknown, init?: RequestInit) => {
        expect((init!.body as FormData).get('model')).toBe('gpt-transcribe');
        expect((init!.body as FormData).get('languages[]')).toBe('en');
        expect((init!.body as FormData).has('language')).toBe(false);
        return Response.json({ text: 'Hello', duration: 60 });
      },
    );
    const client = new LLMClient({ openaiApiKey: 'test', fetchImplementation });
    const input = { file: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' };
    const response = await client.transcribe({
      input,
      inputAudioSeconds: 60,
      language: 'en',
    });
    expect(response).toMatchObject({
      model: 'gpt-transcribe',
      text: 'Hello',
      usage: { costUSD: 0.0045 },
    });
    expect(
      calcSpeechCostUSD({ model: 'gpt-transcribe', inputAudioSeconds: 60 })
        .costUSD,
    ).toBe(0.0045);
    expect(client.models.get('gpt-transcribe').contextWindow).toBeUndefined();
    await expect(
      client.transcribe({ input, inputAudioSeconds: 60, budgetUsd: 0.0044 }),
    ).rejects.toThrow('budget');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy transcription options on the new default before fetching audio or the provider', async () => {
    const fetchImplementation = vi.fn();
    const client = new LLMClient({ openaiApiKey: 'test', fetchImplementation });
    for (const legacy of [
      { diarization: true },
      { timestampGranularities: ['word'], responseFormat: 'verbose_json' },
      { responseFormat: 'srt' },
      { temperature: 0.2 },
      { providerOptions: { openai: { chunkingStrategy: 'auto' } } },
    ]) {
      await expect(
        client.transcribe({
          input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
          ...legacy,
        } as never),
      ).rejects.toThrow('gpt-transcribe');
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
