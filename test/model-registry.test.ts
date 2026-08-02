import { describe, expect, it, vi } from 'vitest';

import { ProviderCapabilityError } from '../src/errors.js';
import { defaultModelPrices } from '../src/models/prices.js';
import { ModelRegistry } from '../src/models/registry.js';
import pricesJson from '../src/models/prices.json';

describe('ModelRegistry', () => {
  const validCompletion = {
    contextWindow: 64000,
    id: 'custom-model',
    inputPrice: 1,
    kind: 'completion' as const,
    lastUpdated: '2026-07-30',
    outputPrice: 2,
    provider: 'mock' as const,
    supportsStreaming: true,
    supportsTools: false,
    supportsVision: false,
  };

  it('keeps the typed and JSON seeds identical with kind-aware metadata', () => {
    expect(defaultModelPrices).toEqual(pricesJson);

    const registry = new ModelRegistry(undefined, {
      emitStalenessWarning: false,
    });
    expect(registry.get('gpt-5.5').contextWindow).toBe(1_050_000);
    expect(registry.get('gpt-5.4').contextWindow).toBe(1_050_000);
    expect(registry.get('gpt-5.4-mini')).toMatchObject({
      contextWindow: 400_000,
      maxInputTokens: 272_000,
    });
    expect(registry.get('gpt-5.4-nano')).toMatchObject({
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      supportsVision: true,
    });
    expect(registry.get('claude-sonnet-4-6').contextWindow).toBe(1_000_000);
    expect(registry.get('claude-opus-4-6').contextWindow).toBe(1_000_000);
    for (const id of [
      'gpt-4o-mini-transcribe',
      'gpt-4o-mini-transcribe-2025-12-15',
      'gpt-4o-transcribe',
      'gpt-4o-transcribe-diarize',
    ]) {
      expect(registry.get(id)).toMatchObject({
        contextWindow: 16_000,
        kind: 'transcription',
        supportedInputModalities: ['audio', 'text'],
      });
    }
    expect(registry.get('whisper-1')).toMatchObject({
      contextWindow: 224,
      kind: 'transcription',
    });
    expect(registry.list().every((model) => model.contextWindow > 0)).toBe(
      true,
    );
  });

  it('keeps every seeded model complete for its declared kind', () => {
    const registry = new ModelRegistry(undefined, {
      emitStalenessWarning: false,
    });
    const allowedKinds = ['completion', 'embedding', 'speech', 'transcription'];
    const allowedProviders = [
      'anthropic',
      'azure-openai',
      'bedrock',
      'cohere',
      'google',
      'groq',
      'mistral',
      'mock',
      'ollama',
      'openai',
    ];

    for (const model of registry.list()) {
      expect(model.id.trim().length).toBeGreaterThan(0);
      expect(allowedProviders).toContain(model.provider);
      expect(allowedKinds).toContain(model.kind);
      expect(Number.isSafeInteger(model.contextWindow)).toBe(true);
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(Number.isFinite(model.inputPrice)).toBe(true);
      expect(model.inputPrice).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(model.outputPrice)).toBe(true);
      expect(model.outputPrice).toBeGreaterThanOrEqual(0);
      expect(model.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${model.lastUpdated}T00:00:00Z`))).toBe(
        false,
      );
      expect(typeof model.supportsStreaming).toBe('boolean');
      expect(typeof model.supportsTools).toBe('boolean');
      expect(typeof model.supportsVision).toBe('boolean');

      for (const price of [model.cacheReadPrice, model.cacheWritePrice]) {
        if (price !== undefined) {
          expect(Number.isFinite(price)).toBe(true);
          expect(price).toBeGreaterThanOrEqual(0);
        }
      }

      if (model.kind === 'embedding') {
        expect(model.embeddingDimensions?.default).toBeGreaterThan(0);
        expect(model.supportedInputModalities?.length).toBeGreaterThan(0);
      }

      if (model.kind === 'speech' || model.kind === 'transcription') {
        expect(model.supportedInputModalities?.length).toBeGreaterThan(0);
        expect(model.supportedOutputModalities?.length).toBeGreaterThan(0);
        expect(Object.keys(model.speechPrices ?? {}).length).toBeGreaterThan(0);
        for (const price of Object.values(model.speechPrices ?? {})) {
          expect(Number.isFinite(price)).toBe(true);
          expect(price).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('clones nested metadata on get and list return paths', () => {
    const registry = new ModelRegistry(undefined, {
      emitStalenessWarning: false,
    });
    const retrievedEmbedding = registry.get('gemini-embedding-2');
    retrievedEmbedding.embeddingDimensions!.recommended!.push(512);
    retrievedEmbedding.supportedInputModalities!.push('video');

    const listedSpeech = registry
      .list()
      .find((model) => model.id === 'gpt-4o-mini-tts')!;
    listedSpeech.speechPrices!.requestPrice = 99;
    listedSpeech.supportedOutputModalities!.push('text');

    expect(registry.get('gemini-embedding-2').embeddingDimensions).toEqual({
      default: 3072,
      max: 3072,
      min: 128,
      recommended: [768, 1536, 3072],
    });
    expect(registry.get('gemini-embedding-2').supportedInputModalities).toEqual(
      ['audio', 'document', 'image', 'text'],
    );
    expect(registry.get('gpt-4o-mini-tts').speechPrices).toEqual({
      outputAudioSecondPrice: 0.00025,
      textInputTokenPrice: 0.6,
    });
    expect(registry.get('gpt-4o-mini-tts').supportedOutputModalities).toEqual([
      'audio',
    ]);
  });

  it('lists seeded models', () => {
    const registry = new ModelRegistry();
    const modelIds = registry.list().map((model) => model.id);

    expect(modelIds).toEqual(
      expect.arrayContaining([
        'claude-fable-5',
        'claude-haiku-4-5-20251001',
        'claude-opus-5',
        'claude-sonnet-4-6',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.6-flash',
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-lite',
        'gpt-5.5',
        'gpt-5.6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6',
      ]),
    );
    expect(registry.isSupported('claude-fable-5')).toBe(true);
    expect(registry.isSupported('claude-haiku-4-5-20251001')).toBe(true);
    expect(registry.isSupported('claude-opus-5')).toBe(true);
    expect(registry.isSupported('claude-sonnet-4-6')).toBe(true);
    expect(registry.isSupported('gemini-3.5-flash')).toBe(true);
    expect(registry.isSupported('gemini-3.5-flash-lite')).toBe(true);
    expect(registry.isSupported('gemini-3.6-flash')).toBe(true);
    expect(registry.isSupported('gemini-3.1-pro-preview')).toBe(true);
    expect(registry.isSupported('gemini-3.1-flash-lite')).toBe(true);
    expect(registry.isSupported('gpt-5.5')).toBe(true);
    expect(registry.isSupported('gpt-5.6-luna')).toBe(true);
    expect(registry.isSupported('gpt-5.6-sol')).toBe(true);
    expect(registry.isSupported('gpt-5.6-terra')).toBe(true);
    expect(registry.isSupported('gpt-5.6')).toBe(true);
  });

  it('registers the current provider model IDs with their published metadata', () => {
    const registry = new ModelRegistry();

    expect(registry.get('gpt-5.6-luna')).toMatchObject({
      contextWindow: 1050000,
      inputPrice: 1,
      outputPrice: 6,
      provider: 'openai',
      cacheReadPrice: 0.1,
      cacheWritePrice: 1.25,
    });
    expect(registry.get('gpt-5.6-sol')).toMatchObject({
      contextWindow: 1050000,
      inputPrice: 5,
      outputPrice: 30,
      provider: 'openai',
      cacheReadPrice: 0.5,
      cacheWritePrice: 6.25,
    });
    expect(registry.get('gpt-5.6')).toMatchObject({
      contextWindow: 1050000,
      inputPrice: 5,
      outputPrice: 30,
      provider: 'openai',
    });
    expect(registry.get('gpt-5.6-terra')).toMatchObject({
      contextWindow: 1050000,
      inputPrice: 2.5,
      outputPrice: 15,
      provider: 'openai',
      cacheReadPrice: 0.25,
      cacheWritePrice: 3.125,
    });
    expect(registry.get('claude-haiku-4-5-20251001')).toMatchObject({
      contextWindow: 200000,
      inputPrice: 1,
      outputPrice: 5,
      provider: 'anthropic',
      cacheReadPrice: 0.1,
      cacheWritePrice: 1.25,
    });
    expect(registry.get('claude-opus-5')).toMatchObject({
      contextWindow: 1000000,
      inputPrice: 5,
      outputPrice: 25,
      provider: 'anthropic',
      cacheReadPrice: 0.5,
      cacheWritePrice: 6.25,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(registry.get('gemini-3.6-flash')).toMatchObject({
      contextWindow: 1048576,
      inputPrice: 1.5,
      outputPrice: 7.5,
      provider: 'google',
      cacheReadPrice: 0.15,
    });
    expect(registry.get('gemini-3.5-flash-lite')).toMatchObject({
      contextWindow: 1048576,
      inputPrice: 0.3,
      outputPrice: 2.5,
      provider: 'google',
      cacheReadPrice: 0.03,
    });
    expect(registry.get('gemini-3.1-flash-lite')).toMatchObject({
      contextWindow: 1048576,
      inputPrice: 0.25,
      outputPrice: 1.5,
      provider: 'google',
      cacheReadPrice: 0.025,
    });
  });

  it('seeds Anthropic effort subsets and leaves unsupported models fail-closed', () => {
    const registry = new ModelRegistry();

    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6']) {
      expect(registry.get(model).supportedReasoningEfforts).toEqual([
        'low',
        'medium',
        'high',
        'max',
      ]);
    }
    for (const model of ['claude-opus-5', 'claude-fable-5']) {
      expect(registry.get(model).supportedReasoningEfforts).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
    for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
      expect(registry.get(model).supportedReasoningEfforts).toBeUndefined();
    }

    registry.register({
      contextWindow: 64000,
      id: 'custom-anthropic',
      inputPrice: 1,
      kind: 'completion',
      lastUpdated: '2026-07-29',
      outputPrice: 2,
      provider: 'anthropic',
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false,
    });
    expect(
      registry.get('custom-anthropic').supportedReasoningEfforts,
    ).toBeUndefined();
  });

  it('returns a model and validates capabilities', () => {
    const registry = new ModelRegistry();

    expect(registry.get('gpt-4o').provider).toBe('openai');
    expect(
      registry.assertCapability('gpt-4o', 'supportsTools', 'tool calling').id,
    ).toBe('gpt-4o');
    expect(() =>
      registry.assertCapability('gpt-4o-mini-tts', 'supportsVision', 'vision'),
    ).toThrow(ProviderCapabilityError);
    expect(
      registry.assertModelKind('gemini-embedding-2', 'embedding').kind,
    ).toBe('embedding');
    expect(registry.get('gemini-embedding-2').embeddingDimensions).toEqual({
      default: 3072,
      max: 3072,
      min: 128,
      recommended: [768, 1536, 3072],
    });
  });

  it('defaults legacy models to completion kind and rejects mismatched kinds', () => {
    const registry = new ModelRegistry();

    expect(registry.get('gpt-4o').kind).toBe('completion');
    expect(() => registry.assertModelKind('gpt-4o', 'embedding')).toThrow(
      ProviderCapabilityError,
    );
  });

  it('adds structured-output capability metadata for built-in completion models only', () => {
    const registry = new ModelRegistry();

    expect(registry.get('gpt-4o')).toMatchObject({
      supportsJsonObjectOutput: true,
      supportsJsonSchemaOutput: true,
      supportsStructuredOutputStreaming: true,
    });
    expect(registry.get('gemini-2.5-flash')).toMatchObject({
      supportsJsonObjectOutput: true,
      supportsJsonSchemaOutput: true,
      supportsStructuredOutputStreaming: true,
    });
    expect(registry.get('claude-sonnet-4-6')).toMatchObject({
      supportsJsonSchemaOutput: true,
      supportsStructuredOutputStreaming: true,
    });
    expect(
      registry.get('claude-sonnet-4-6').supportsJsonObjectOutput,
    ).toBeUndefined();
    expect(
      registry.get('gemini-embedding-2').supportsJsonSchemaOutput,
    ).toBeUndefined();

    registry.register({
      contextWindow: 64000,
      id: 'custom-openai',
      inputPrice: 1,
      kind: 'completion',
      lastUpdated: '2026-04-15',
      outputPrice: 2,
      provider: 'openai',
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false,
    });

    expect(
      registry.get('custom-openai').supportsJsonSchemaOutput,
    ).toBeUndefined();
  });

  it('throws for unknown models', () => {
    const registry = new ModelRegistry();

    expect(() => registry.get('missing-model')).toThrow(
      ProviderCapabilityError,
    );
  });

  it('registers custom models and updates prices', () => {
    const registry = new ModelRegistry();

    registry.register({
      contextWindow: 64000,
      id: 'custom-model',
      inputPrice: 1,
      kind: 'completion',
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

  it('rejects incomplete registrations before replacing an existing record', () => {
    const registry = new ModelRegistry(undefined, {
      emitStalenessWarning: false,
    });
    registry.register(validCompletion);

    const invalidModels = [
      { ...validCompletion, id: ' ' },
      { ...validCompletion, provider: 'unknown' },
      { ...validCompletion, kind: undefined },
      { ...validCompletion, inputPrice: Number.NaN },
      { ...validCompletion, outputPrice: -1 },
      { ...validCompletion, contextWindow: 0 },
      { ...validCompletion, supportsTools: undefined },
      { ...validCompletion, lastUpdated: 'not-a-date' },
      { ...validCompletion, lastUpdated: '2026-02-31' },
    ];

    for (const invalid of invalidModels) {
      expect(() => registry.register(invalid as never)).toThrow(
        ProviderCapabilityError,
      );
    }
    expect(registry.get(validCompletion.id)).toMatchObject(validCompletion);
  });

  it('validates every constructor seed before exposing registry state', () => {
    for (const invalid of [
      { ...validCompletion, inputPrice: undefined },
      { ...validCompletion, outputPrice: Number.NaN },
      { ...validCompletion, inputPrice: Number.POSITIVE_INFINITY },
      { ...validCompletion, outputPrice: -1 },
      { ...validCompletion, contextWindow: 0 },
      { ...validCompletion, supportsStreaming: undefined },
    ]) {
      const { id, ...seed } = invalid;
      expect(
        () =>
          new ModelRegistry(
            { [id]: seed as never },
            { emitStalenessWarning: false },
          ),
      ).toThrow(ProviderCapabilityError);
    }

    const { id, ...freeSeed } = {
      ...validCompletion,
      id: 'registered-free-model',
      inputPrice: 0,
      outputPrice: 0,
    };
    expect(
      new ModelRegistry(
        { [id]: freeSeed },
        { emitStalenessWarning: false },
      ).get(id),
    ).toMatchObject({ inputPrice: 0, outputPrice: 0 });
  });

  it('accepts kind-relevant custom metadata and zero prices', () => {
    const registry = new ModelRegistry(undefined, {
      emitStalenessWarning: false,
    });
    for (const model of [
      validCompletion,
      {
        ...validCompletion,
        id: 'custom-embedding',
        inputPrice: 0,
        kind: 'embedding' as const,
        outputPrice: 0,
        supportedInputModalities: ['text'] as Array<'text'>,
      },
      {
        ...validCompletion,
        id: 'custom-speech',
        inputPrice: 0,
        kind: 'speech' as const,
        outputPrice: 0,
        speechPrices: { requestPrice: 0 },
        supportedInputModalities: ['text'] as Array<'text'>,
        supportedOutputModalities: ['audio'] as Array<'audio'>,
      },
      {
        ...validCompletion,
        contextWindow: 224,
        id: 'custom-transcription',
        kind: 'transcription' as const,
        supportedInputModalities: ['audio'] as Array<'audio'>,
        supportedOutputModalities: ['text'] as Array<'text'>,
      },
    ]) {
      expect(registry.register(model).id).toBe(model.id);
    }
  });

  it('validates price overrides atomically, including nested units', () => {
    const registry = new ModelRegistry(undefined, {
      emitStalenessWarning: false,
    });
    const beforeGpt = registry.get('gpt-4o');
    const beforeSpeech = registry.get('gpt-4o-mini-tts');

    for (const value of [-1, Number.NaN, Infinity, -Infinity, '1']) {
      expect(() =>
        registry.updatePrices({
          'gpt-4o': { inputPrice: value as never },
        }),
      ).toThrow(ProviderCapabilityError);
    }
    expect(() =>
      registry.updatePrices({
        'gpt-4o': { provider: 'anthropic' } as never,
      }),
    ).toThrow(ProviderCapabilityError);
    expect(() =>
      registry.updatePrices({
        'gpt-4o': { cacheReadPrice: 'free' as never },
      }),
    ).toThrow(ProviderCapabilityError);
    expect(() =>
      registry.updatePrices({
        'gpt-4o-mini-tts': {
          speechPrices: { outputAudioSecondPrice: Infinity },
        },
      }),
    ).toThrow(ProviderCapabilityError);
    expect(() =>
      registry.updatePrices({
        'gpt-4o': { inputPrice: 0 },
        'gpt-4o-mini-tts': {
          speechPrices: { outputAudioSecondPrice: Number.NaN },
        },
      }),
    ).toThrow(ProviderCapabilityError);
    expect(registry.get('gpt-4o')).toEqual(beforeGpt);
    expect(registry.get('gpt-4o-mini-tts')).toEqual(beforeSpeech);

    registry.updatePrices({
      'gpt-4o': { cacheReadPrice: 0, inputPrice: 0, outputPrice: 0 },
      'gpt-4o-mini-tts': { speechPrices: { requestPrice: 0 } },
    });
    expect(registry.get('gpt-4o')).toMatchObject({
      cacheReadPrice: 0,
      inputPrice: 0,
      outputPrice: 0,
    });
    expect(registry.get('gpt-4o-mini-tts').speechPrices).toEqual({
      requestPrice: 0,
    });
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

  it('rejects invalid constructor seed metadata before staleness checks', () => {
    const warning = vi.fn();
    expect(
      () =>
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
        ),
    ).toThrow(ProviderCapabilityError);

    expect(warning).not.toHaveBeenCalled();
  });
});
