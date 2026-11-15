import { describe, expect, it, vi } from 'vitest';

import { LLMClient } from '../src/client.js';
import { ProviderCapabilityError } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import { OpenAIAdapter } from '../src/providers/openai.js';
import type { ProviderOptions } from '../src/types.js';

const models = [
  ['gpt-6-astra', 'openai'],
  ['gpt-6.1-sol', 'openai'],
  ['gpt-6.1-terra', 'openai'],
  ['gpt-6-luna', 'openai'],
  ['claude-fable-5-2', 'anthropic'],
  ['claude-opus-5-5', 'anthropic'],
  ['claude-sonnet-5-5', 'anthropic'],
  ['claude-haiku-5-5', 'anthropic'],
  ['gemini-4-carbon', 'google'],
  ['gemini-4-argon', 'google'],
  ['gemini-4-hydrogen', 'google'],
  ['gemini-3.8-flash', 'google'],
] as const;

function payload(provider: string, model: string) {
  if (provider === 'anthropic')
    return {
      content: [{ type: 'text', text: 'Hello' }],
      id: 'msg_test',
      model,
      role: 'assistant',
      stop_reason: 'end_turn',
      type: 'message',
      usage: { input_tokens: 2, output_tokens: 1 },
    };
  if (provider === 'google')
    return {
      candidates: [
        {
          content: { parts: [{ text: 'Hello' }], role: 'model' },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      modelVersion: model,
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 1,
        totalTokenCount: 3,
      },
    };
  return {
    id: 'resp_test',
    model,
    status: 'completed',
    output: [
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

function streamPayload(provider: string, model: string) {
  const result = payload(provider, model);
  const events =
    provider === 'anthropic'
      ? [
          {
            type: 'message_start',
            message: { ...result, content: [], stop_reason: null },
          },
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
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ]
      : provider === 'google'
        ? [result]
        : [
            {
              type: 'response.output_text.delta',
              delta: 'Hello',
              output_index: 0,
              content_index: 0,
              item_id: 'msg_test',
            },
            { type: 'response.completed', response: result },
          ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('current provider models', () => {
  it.each(models)(
    'dispatches %s through completion and streaming with normalized usage',
    async (model, provider) => {
      const fetchImplementation = vi.fn(
        async (url: unknown, init?: RequestInit) => {
          const target = new URL(String(url));
          const body = JSON.parse(init!.body as string);
          if (provider === 'google') {
            expect(target.hostname).toBe('generativelanguage.googleapis.com');
            expect(target.pathname).toContain(`/models/${model}:`);
          } else {
            expect(body.model).toBe(model);
            expect(target.hostname).toBe(
              provider === 'openai' ? 'api.openai.com' : 'api.anthropic.com',
            );
            expect(target.pathname).toBe(
              provider === 'openai' ? '/v1/responses' : '/v1/messages',
            );
          }
          return body.stream ||
            target.pathname.endsWith(':streamGenerateContent')
            ? streamPayload(provider, model)
            : Response.json(payload(provider, model));
        },
      );
      const client = new LLMClient({
        openaiApiKey: 'test',
        anthropicApiKey: 'test',
        geminiApiKey: 'test',
        fetchImplementation,
      });
      const request = {
        model,
        messages: [{ role: 'user' as const, content: 'Hello' }],
      };
      const response = await client.complete(request);
      expect(response).toMatchObject({
        model,
        provider,
        text: 'Hello',
        usage: { inputTokens: 2, outputTokens: 1 },
      });
      expect(response.usage.costUSD).toBeGreaterThan(0);
      let text = '';
      let done = false;
      for await (const chunk of client.stream(request)) {
        if (chunk.type === 'text-delta') text += chunk.delta;
        if (chunk.type === 'done') {
          done = true;
          expect(chunk).toMatchObject({
            usage: { inputTokens: 2, outputTokens: 1 },
          });
        }
      }
      expect(text).toBe('Hello');
      expect(done).toBe(true);
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['gpt-6-astra', { openai: { reasoning: { effort: 'none' } } }],
    ['gpt-6.1-sol', { openai: { reasoning: { effort: 'none' } } }],
    ['gpt-6-luna', { openai: { reasoning: { effort: 'minimal' } } }],
    ['gemini-4-carbon', { google: { thinking: { level: 'xhigh' } } }],
    ['gemini-4-argon', { google: { thinking: { level: 'minimal' } } }],
    ['gemini-4-hydrogen', { google: { thinking: { budgetTokens: 1_000 } } }],
    [
      'gemini-4-hydrogen',
      { google: { promptCaching: { cachedContent: 'cachedContents/test' } } },
    ],
    ['claude-fable-5-2', { anthropic: { thinking: { type: 'disabled' } } }],
    ['claude-opus-5-5', { anthropic: { thinking: { type: 'enabled' } } }],
    ['claude-sonnet-5-5', { anthropic: { thinking: { type: 'disabled' } } }],
    [
      'claude-haiku-5-5',
      { anthropic: { effort: 'max', thinking: { type: 'disabled' } } },
    ],
    ['claude-opus-5-5', { anthropic: { thinking: { type: 'between_tools' } } }],
    [
      'claude-sonnet-5-5',
      { anthropic: { effort: 'xhigh', thinking: { type: 'between_tools' } } },
    ],
  ] as Array<[string, ProviderOptions]>)(
    'rejects unsupported %s options before transport: %j',
    async (model, providerOptions) => {
      const fetchImplementation = vi.fn();
      const client = new LLMClient({
        openaiApiKey: 'test',
        anthropicApiKey: 'test',
        geminiApiKey: 'test',
        fetchImplementation,
      });
      await expect(
        client.complete({
          model,
          messages: [{ role: 'user', content: 'Hello' }],
          providerOptions,
        }),
      ).rejects.toBeInstanceOf(ProviderCapabilityError);
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it('preserves supported GPT-6 sampling and rejects it when reasoning is enabled', async () => {
    const fetchImplementation = vi.fn(
      async (_url: unknown, init?: RequestInit) => {
        expect(JSON.parse(init!.body as string)).toMatchObject({
          temperature: 0.2,
          reasoning: { effort: 'none' },
        });
        return Response.json(payload('openai', 'gpt-6.1-terra'));
      },
    );
    const client = new LLMClient({ openaiApiKey: 'test', fetchImplementation });
    const options = {
      model: 'gpt-6.1-terra',
      temperature: 0.2,
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    await client.complete({
      ...options,
      providerOptions: { openai: { reasoning: { effort: 'none' } } },
    });
    await expect(client.complete(options)).rejects.toThrow('sampling');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('sends Hydrogen xhigh while omitting obsolete sampling parameters', async () => {
    const fetchImplementation = vi.fn(
      async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe(
          'xhigh',
        );
        expect(body.generationConfig).not.toHaveProperty('temperature');
        return Response.json(payload('google', 'gemini-4-hydrogen'));
      },
    );
    const client = new LLMClient({ geminiApiKey: 'test', fetchImplementation });
    await client.complete({
      model: 'gemini-4-hydrogen',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.2,
      providerOptions: { google: { thinking: { level: 'xhigh' } } },
    });
  });

  it('supports Sonnet between-tools thinking and Haiku disabled thinking at low effort', async () => {
    const fetchImplementation = vi.fn(
      async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        expect(body.output_config.effort).toBe('low');
        expect(body.thinking.type).toBe(
          body.model === 'claude-sonnet-5-5' ? 'between_tools' : 'disabled',
        );
        return Response.json(payload('anthropic', body.model));
      },
    );
    const client = new LLMClient({
      anthropicApiKey: 'test',
      fetchImplementation,
    });
    for (const model of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
      await client.complete({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        providerOptions: {
          anthropic: {
            effort: 'low',
            thinking: {
              type:
                model === 'claude-sonnet-5-5' ? 'between_tools' : 'disabled',
            },
          },
        },
      });
    }
  });

  it('blocks retired models in standalone adapters, including streaming and audio', async () => {
    const fetchImplementation = vi.fn();
    const modelRegistry = new ModelRegistry(undefined, {
      now: () => new Date('2027-03-01'),
      emitStalenessWarning: false,
    });
    const adapter = new OpenAIAdapter({
      apiKey: 'test',
      fetchImplementation,
      modelRegistry,
    });
    await expect(
      adapter.complete({ model: 'gpt-4o', messages: [] }),
    ).rejects.toThrow('retired');
    await expect(
      adapter.stream({ model: 'gpt-4o', messages: [] }).next(),
    ).rejects.toThrow('retired');
    await expect(
      adapter.speak({ model: 'tts-1', provider: 'openai', input: 'Hello' }),
    ).rejects.toThrow('retired');
    await expect(
      adapter.transcribe({
        model: 'whisper-1',
        provider: 'openai',
        input: { file: new Uint8Array([1]), mediaType: 'audio/mpeg' },
      }),
    ).rejects.toThrow('retired');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('dispatches Google redirects with the replacement ID and its actual usage costs', async () => {
    const fetchImplementation = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('/models/gemini-3.8-flash:generateContent');
      return Response.json(payload('google', 'gemini-3.8-flash'));
    });
    const client = new LLMClient({
      geminiApiKey: 'test',
      fetchImplementation,
      modelRegistryOptions: { now: () => new Date('2026-12-01') },
    });
    const result = await client.complete({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.model).toBe('gemini-3.8-flash');
    expect(result.usage.costUSD).toBe(0.00000525);
  });
});
