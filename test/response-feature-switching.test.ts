import { describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../src/client.js';
import { ProviderCapabilityError } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import { getResponseCapabilities } from '../src/models/response-capabilities.js';
import { translateAnthropicRequest } from '../src/providers/anthropic.js';
import { translateGeminiRequest } from '../src/providers/gemini.js';
import { translateOpenAIRequest } from '../src/providers/openai.js';
import { ModelRouter } from '../src/router.js';
import { InMemorySessionStore } from '../src/session-store.js';
import type { ConversationSnapshot } from '../src/conversation.js';
import type { CanonicalMessage, ProviderOptions } from '../src/types.js';

const messages: CanonicalMessage[] = [{ role: 'user', content: 'Hello' }];
const controls: ProviderOptions = {
  openai: { verbosity: 'low', reasoning: { effort: 'low', summary: 'auto' } },
};
const targets = ['gpt-4o', 'claude-sonnet-4-6', 'gemini-2.5-flash'];
const pdf: CanonicalMessage = {
  role: 'user',
  content: [
    { type: 'document', mediaType: 'application/pdf', data: 'JVBERi0xLjcK' },
  ],
};

function payload(model: string) {
  if (model.startsWith('claude'))
    return {
      id: 'msg_test',
      model,
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  if (model.startsWith('gemini'))
    return {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'Hello' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        totalTokenCount: 12,
      },
    };
  return {
    id: 'resp_test',
    model,
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_test',
        content: [{ type: 'output_text', text: 'Hello' }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function providerResponse(model: string, stream = false): Response {
  const result = payload(model);
  if (!stream) return Response.json(result);
  const events = model.startsWith('claude')
    ? [
        { type: 'message_start', message: { ...result, content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ]
    : model.startsWith('gemini')
      ? [result]
      : [{ type: 'response.completed', response: result }];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function client(fetchImplementation: typeof fetch, extra = {}) {
  return new LLMClient({
    openaiApiKey: 'test',
    anthropicApiKey: 'test',
    geminiApiKey: 'test',
    fetchImplementation,
    retryOptions: { maxAttempts: 1 },
    ...extra,
  });
}

describe('response capability inspection', () => {
  it.each([
    ['gpt-6.1-sol', true, true],
    ['gpt-4o', false, false],
    ['o3', false, true],
    ['claude-sonnet-4-6', false, false],
    ['gemini-4-carbon', false, false],
  ])('reports adapter support for %s', (model, verbosity, reasoningSummary) => {
    const registry = new ModelRegistry();
    expect(registry.getResponseCapabilities(model as string)).toEqual({
      pdfInput: true,
      verbosity,
      reasoningSummary,
    });
  });

  it('does not infer completion features from a non-completion or non-vision model', () => {
    expect(
      getResponseCapabilities({
        id: 'gpt-6-custom',
        provider: 'openai',
        kind: 'embedding',
        supportsVision: true,
      }),
    ).toEqual({ pdfInput: false, verbosity: false, reasoningSummary: false });
    expect(
      getResponseCapabilities({
        id: 'custom',
        provider: 'google',
        supportsVision: false,
      }).pdfInput,
    ).toBe(false);
  });

  it('resolves a provider redirect before inspecting support', () => {
    const registry = new ModelRegistry();
    expect(registry.getResponseCapabilities('gemini-3.1-flash-lite')).toEqual(
      registry.getResponseCapabilities(
        registry.resolve('gemini-3.1-flash-lite').id,
      ),
    );
  });
});

describe.each(targets)('switching to %s', (model) => {
  it.each([false, true])(
    'rejects unsupported controls before transport (stream=%s)',
    async (stream) => {
      const fetchImplementation = vi.fn(async () =>
        providerResponse(model, stream),
      );
      const llm = client(fetchImplementation);
      const options = { model, messages, providerOptions: controls };
      await expect(
        stream ? collect(llm.stream(options)) : llm.complete(options),
      ).rejects.toMatchObject({
        name: 'ProviderCapabilityError',
        model,
        details: { unsupported: ['openai.verbosity', 'openai.reasoning'] },
      });
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'explicitly omits controls while preserving PDF input (stream=%s)',
    async (stream) => {
      const fetchImplementation = vi.fn(
        async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string);
          expect(body).not.toHaveProperty('reasoning');
          expect(body.text?.verbosity).toBeUndefined();
          expect(JSON.stringify(body)).toContain('JVBERi0xLjcK');
          return providerResponse(model, stream);
        },
      );
      const llm = client(fetchImplementation);
      const options = {
        model,
        messages: [pdf],
        providerOptions: {
          ...controls,
          unsupportedFeaturePolicy: 'omit' as const,
        },
      };
      const before = JSON.stringify(options);
      if (stream)
        expect((await collect(llm.stream(options))).at(-1)?.type).toBe('done');
      else expect((await llm.complete(options)).text).toBe('Hello');
      expect(JSON.stringify(options)).toBe(before);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    },
  );

  it('never drops PDFs to accommodate a model without vision', async () => {
    const registry = new ModelRegistry();
    registry.register({ ...registry.get(model), supportsVision: false });
    const fetchImplementation = vi.fn(async () => providerResponse(model));
    await expect(
      client(fetchImplementation, { modelRegistry: registry }).complete({
        model,
        messages: [pdf],
        providerOptions: { ...controls, unsupportedFeaturePolicy: 'omit' },
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe('response feature policy', () => {
  it('keeps supported reasoning on o3 while dropping unsupported verbosity', () => {
    const body = translateOpenAIRequest({
      model: 'o3',
      messages,
      providerOptions: { ...controls, unsupportedFeaturePolicy: 'omit' },
    });
    expect(body).toHaveProperty('reasoning', {
      effort: 'low',
      summary: 'auto',
    });
    expect(body.text).toBeUndefined();
  });

  it('keeps structured formatting when an older OpenAI model omits response controls', () => {
    const body = translateOpenAIRequest({
      model: 'gpt-4o',
      system: 'Return JSON.',
      messages,
      responseFormat: { type: 'json_object' },
      providerOptions: { ...controls, unsupportedFeaturePolicy: 'omit' },
    });
    expect(body.text).toEqual({ format: { type: 'json_object' } });
    expect(body).not.toHaveProperty('reasoning');
  });

  it.each([
    { openai: { verbosity: 'low' as const } },
    { openai: { reasoning: { summary: 'auto' as const } } },
  ])('reports a single unsupported feature clearly', (providerOptions) => {
    expect(() =>
      translateGeminiRequest({
        model: 'gemini-4-carbon',
        messages,
        providerOptions,
      }),
    ).toThrow(/unsupportedFeaturePolicy/);
  });

  it('preserves separately configured native thinking and caching settings', () => {
    const google = translateGeminiRequest({
      model: 'gemini-4-carbon',
      messages,
      providerOptions: {
        ...controls,
        unsupportedFeaturePolicy: 'omit',
        google: { thinking: { level: 'high', includeThoughts: true } },
      },
    });
    expect(google.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
    });
    const anthropic = translateAnthropicRequest({
      maxTokens: 1024,
      model: 'claude-sonnet-4-6',
      messages,
      providerOptions: {
        ...controls,
        unsupportedFeaturePolicy: 'omit',
        anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
      },
    });
    expect(anthropic).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    const openai = translateOpenAIRequest({
      model: 'gpt-4o',
      messages,
      providerOptions: {
        ...controls,
        unsupportedFeaturePolicy: 'omit',
        openai: { ...controls.openai, promptCaching: { key: 'cache-key' } },
      },
    });
    expect(openai).toHaveProperty('prompt_cache_key', 'cache-key');
  });

  it('keeps supported OpenAI controls under either policy', () => {
    for (const unsupportedFeaturePolicy of ['error', 'omit'] as const) {
      const body = translateOpenAIRequest({
        model: 'gpt-6.1-sol',
        messages,
        providerOptions: { ...controls, unsupportedFeaturePolicy },
      });
      expect(body).toMatchObject({
        text: { verbosity: 'low' },
        reasoning: { effort: 'low', summary: 'auto' },
      });
      expect(body).not.toHaveProperty('unsupportedFeaturePolicy');
    }
  });

  it('rejects an invalid runtime policy even when no feature needs omission', () => {
    expect(() =>
      translateOpenAIRequest({
        model: 'gpt-6.1-sol',
        messages,
        providerOptions: { unsupportedFeaturePolicy: 'drop-input' as never },
      }),
    ).toThrow(/must be "error" or "omit"/);
  });
});

describe('model fallback and persisted switching', () => {
  const modelRouter = new ModelRouter({
    rules: [
      {
        name: 'switch',
        target: 'gpt-6.1-sol',
        fallback: ['claude-sonnet-4-6'],
      },
    ],
  });

  it('does not reject an unused incompatible fallback', async () => {
    const fetchImplementation = vi.fn(async () =>
      providerResponse('gpt-6.1-sol'),
    );
    expect(
      (
        await client(fetchImplementation, { modelRouter }).complete({
          messages,
          providerOptions: controls,
        })
      ).provider,
    ).toBe('openai');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'handles an attempted fallback using the selected policy (omit=%s)',
    async (omit) => {
      const fetchImplementation = vi.fn(async (url: unknown) =>
        String(url).includes('openai')
          ? Response.json(
              { error: { message: 'Unavailable' } },
              { status: 503 },
            )
          : providerResponse('claude-sonnet-4-6'),
      );
      const options = {
        messages,
        providerOptions: {
          ...controls,
          unsupportedFeaturePolicy: omit
            ? ('omit' as const)
            : ('error' as const),
        },
      };
      const result = client(fetchImplementation, { modelRouter }).complete(
        options,
      );
      if (omit) expect((await result).provider).toBe('anthropic');
      else await expect(result).rejects.toBeInstanceOf(ProviderCapabilityError);
      expect(fetchImplementation).toHaveBeenCalledTimes(omit ? 2 : 1);
    },
  );

  it.each([false, true])(
    'applies the same policy to streaming fallback (omit=%s)',
    async (omit) => {
      const fetchImplementation = vi.fn(async (url: unknown) =>
        String(url).includes('openai')
          ? Response.json(
              { error: { message: 'Unavailable' } },
              { status: 503 },
            )
          : providerResponse('claude-sonnet-4-6', true),
      );
      const result = collect(
        client(fetchImplementation, { modelRouter }).stream({
          messages,
          providerOptions: {
            ...controls,
            unsupportedFeaturePolicy: omit ? 'omit' : 'error',
          },
        }),
      );
      if (omit) expect((await result).at(-1)?.type).toBe('done');
      else await expect(result).rejects.toBeInstanceOf(ProviderCapabilityError);
      expect(fetchImplementation).toHaveBeenCalledTimes(omit ? 2 : 1);
    },
  );

  it('preserves and validates policy in restored conversations', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const fetchImplementation = vi.fn(async () =>
      providerResponse('gpt-6.1-sol'),
    );
    const llm = client(fetchImplementation, { sessionStore: store });
    const session = await llm.conversation({
      sessionId: 'switch',
      model: 'gpt-6.1-sol',
      providerOptions: { ...controls, unsupportedFeaturePolicy: 'omit' },
    });
    await session.send('Hello');
    const snapshot = session.serialise();
    await store.set('switch', {
      ...snapshot,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
    fetchImplementation.mockImplementation(async () =>
      providerResponse('claude-sonnet-4-6'),
    );
    const restored = await llm.conversation({ sessionId: 'switch' });
    expect(restored.serialise().providerOptions?.unsupportedFeaturePolicy).toBe(
      'omit',
    );
    expect((await restored.send('Continue')).provider).toBe('anthropic');
    await store.set('switch', {
      ...snapshot,
      providerOptions: { unsupportedFeaturePolicy: 'drop-input' as never },
    });
    await expect(
      llm.conversation({ sessionId: 'switch' }),
    ).rejects.toMatchObject({
      details: { path: 'snapshot.providerOptions.unsupportedFeaturePolicy' },
    });
  });
});
