import { describe, expect, it } from 'vitest';

import { BudgetExceededError, LLMError, RateLimitError } from '../../src/errors.js';
import { calcCostUSD } from '../../src/utils/cost.js';
import {
  assertCanonicalResponse,
  collectStream,
  expectNoSecretLeak,
  hasEnv,
  liveClient,
  liveRealEnabled,
  providerModels,
  requireLiveEnv,
  tinyPngBase64,
  weatherTool,
} from './helpers.js';

const liveDescribe = liveRealEnabled ? describe : describe.skip;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function withGeminiGenerateQuotaRetry<T>(action: () => Promise<T>): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Number(process.env.GEMINI_LIVE_QUOTA_RETRY_ATTEMPTS ?? 2),
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const retryAfterSeconds = String((error as Error).message).match(
        /retry in ([\d.]+)s/i,
      )?.[1];
      const isGenerateFreeTierQuota =
        error instanceof RateLimitError &&
        String(error.message).includes('generate_content_free_tier_requests') &&
        retryAfterSeconds;

      if (!isGenerateFreeTierQuota || attempt === maxAttempts) {
        throw error;
      }

      await sleep(Math.ceil(Number(retryAfterSeconds) * 1000) + 1_000);
    }
  }

  throw new Error('unreachable Gemini quota retry state');
}

liveDescribe('live-real provider adapters', () => {
  it('uses OpenAI for completion, streaming, tools, vision, and errors', async () => {
    requireLiveEnv('OPENAI_API_KEY');
    const client = liveClient();
    const model = providerModels.openai;

    const completion = await client.complete({
      maxTokens: 64,
      messages: [{ content: 'Reply with exactly: OPENAI_REAL_OK', role: 'user' }],
      model,
      provider: 'openai',
      temperature: 0,
    });
    assertCanonicalResponse(completion, 'openai');
    expect(completion.text).toContain('OPENAI_REAL_OK');

    const stream = await collectStream(
      client.stream({
        maxTokens: 64,
        messages: [{ content: 'Reply with exactly: OPENAI_STREAM_OK', role: 'user' }],
        model,
        provider: 'openai',
        temperature: 0,
      }),
    );
    expect(stream.done).toBeDefined();
    expect(`${stream.text}`).toContain('OPENAI_STREAM_OK');
    expect(stream.done?.usage.costUSD).toBeGreaterThanOrEqual(0);

    const tool = await client.complete({
      maxTokens: 64,
      messages: [
        {
          content:
            'Use the get_weather tool for Paris. Do not answer from memory.',
          role: 'user',
        },
      ],
      model,
      provider: 'openai',
      temperature: 0,
      toolChoice: { name: 'get_weather', type: 'tool' },
      tools: [weatherTool()],
    });
    assertCanonicalResponse(tool, 'openai');
    expect(tool.finishReason).toBe('tool_call');
    expect(tool.toolCalls[0]?.name).toBe('get_weather');
    expect(tool.toolCalls[0]?.args.city).toEqual(expect.any(String));

    const vision = await client.complete({
      maxTokens: 16,
      messages: [
        {
          content: [
            { text: 'What is the dominant color? Reply with one word.', type: 'text' },
            {
              data: tinyPngBase64,
              mediaType: 'image/png',
              type: 'image_base64',
            },
          ],
          role: 'user',
        },
      ],
      model,
      provider: 'openai',
      temperature: 0,
    });
    assertCanonicalResponse(vision, 'openai');
    expect(vision.text.length).toBeGreaterThan(0);

    await expect(
      client.complete({
        maxTokens: 8,
        messages: [{ content: 'This should fail.', role: 'user' }],
        model: 'not-a-real-openai-model-live-real',
        provider: 'openai',
      }),
    ).rejects.toBeInstanceOf(LLMError);
  }, 300_000);

  it('uses Anthropic for completion, streaming, tools, and errors', async () => {
    requireLiveEnv('ANTHROPIC_API_KEY');
    const client = liveClient();
    const model = providerModels.anthropic;

    const completion = await client.complete({
      maxTokens: 64,
      messages: [{ content: 'Reply with exactly: ANTHROPIC_REAL_OK', role: 'user' }],
      model,
      provider: 'anthropic',
      temperature: 0,
    });
    assertCanonicalResponse(completion, 'anthropic');
    expect(completion.text).toContain('ANTHROPIC_REAL_OK');

    const stream = await collectStream(
      client.stream({
        maxTokens: 64,
        messages: [
          { content: 'Reply with exactly: ANTHROPIC_STREAM_OK', role: 'user' },
        ],
        model,
        provider: 'anthropic',
        temperature: 0,
      }),
    );
    expect(stream.done).toBeDefined();
    expect(stream.text).toContain('ANTHROPIC_STREAM_OK');

    const tool = await client.complete({
      maxTokens: 64,
      messages: [
        {
          content:
            'Use the get_weather tool for Berlin. Do not answer from memory.',
          role: 'user',
        },
      ],
      model,
      provider: 'anthropic',
      temperature: 0,
      toolChoice: { name: 'get_weather', type: 'tool' },
      tools: [weatherTool()],
    });
    assertCanonicalResponse(tool, 'anthropic');
    expect(tool.finishReason).toBe('tool_call');
    expect(tool.toolCalls[0]?.name).toBe('get_weather');

    await expect(
      client.complete({
        maxTokens: 8,
        messages: [{ content: 'This should fail.', role: 'user' }],
        model: 'not-a-real-anthropic-model-live-real',
        provider: 'anthropic',
      }),
    ).rejects.toBeInstanceOf(LLMError);
  }, 90_000);

  it('uses Gemini for completion, streaming, tools, vision, thinking, and errors', async () => {
    requireLiveEnv('GEMINI_API_KEY');
    const client = liveClient();
    const model = providerModels.gemini;

    const completion = await withGeminiGenerateQuotaRetry(() =>
      client.complete({
        maxTokens: 64,
        messages: [{ content: 'Reply with exactly: GEMINI_REAL_OK', role: 'user' }],
        model,
        provider: 'google',
        temperature: 0,
      }),
    );
    assertCanonicalResponse(completion, 'google');
    expect(completion.text).toContain('GEMINI_REAL_OK');

    const stream = await withGeminiGenerateQuotaRetry(() =>
      collectStream(client.stream({
        maxTokens: 64,
        messages: [{ content: 'Reply with exactly: GEMINI_STREAM_OK', role: 'user' }],
        model,
        provider: 'google',
        temperature: 0,
      })),
    );
    expect(stream.done).toBeDefined();
    expect(stream.text).toContain('GEMINI_STREAM_OK');

    const tool = await withGeminiGenerateQuotaRetry(() =>
      client.complete({
        maxTokens: 256,
        messages: [
          {
            content: 'Use get_weather for Tokyo. Do not answer from memory.',
            role: 'user',
          },
        ],
        model,
        provider: 'google',
        temperature: 0,
        toolChoice: { name: 'get_weather', type: 'tool' },
        tools: [weatherTool()],
      }),
    );
    assertCanonicalResponse(tool, 'google');
    expect(tool.finishReason).toBe('tool_call');
    expect(tool.toolCalls[0]?.name).toBe('get_weather');

    const vision = await withGeminiGenerateQuotaRetry(() =>
      client.complete({
        maxTokens: 64,
        messages: [
          {
            content: [
              { text: 'What is in this image? Reply with one short phrase.', type: 'text' },
              {
                data: tinyPngBase64,
                mediaType: 'image/png',
                type: 'image_base64',
              },
            ],
            role: 'user',
          },
        ],
        model,
        provider: 'google',
        temperature: 0,
      }),
    );
    assertCanonicalResponse(vision, 'google');
    expect(vision.text.length).toBeGreaterThan(0);

    const thinking = await withGeminiGenerateQuotaRetry(() =>
      client.complete({
        maxTokens: 32,
        messages: [
          {
            content:
              'Think briefly, then answer only the number: what is 19 + 23?',
            role: 'user',
          },
        ],
        model: providerModels.geminiThinking,
        provider: 'google',
        providerOptions: {
          google: {
            thinking: {
              budgetTokens: 64,
              includeThoughts: true,
            },
          },
        },
        temperature: 0,
      }),
    );
    assertCanonicalResponse(thinking, 'google');
    expect(thinking.usage.reasoningTokens ?? 0).toBeGreaterThan(0);
    expect(thinking.usage.costUSD).toBeGreaterThan(0);
    expect(
      calcCostUSD({
        billableReasoningTokens: thinking.usage.reasoningTokens ?? 0,
        inputTokens: thinking.usage.inputTokens,
        model: providerModels.geminiThinking,
        outputTokens: thinking.usage.outputTokens,
      }),
    ).toBeCloseTo(thinking.usage.costUSD, 9);

    await expect(
      client.complete({
        maxTokens: 8,
        messages: [{ content: 'This should fail.', role: 'user' }],
        model: 'not-a-real-gemini-model-live-real',
        provider: 'google',
      }),
    ).rejects.toBeInstanceOf(LLMError);
  }, 180_000);

  it('enforces budgets before provider calls and supports stream cancellation', async () => {
    requireLiveEnv('OPENAI_API_KEY');
    const client = liveClient();

    await expect(
      client.complete({
        budgetUsd: 0,
        maxTokens: 256,
        messages: [{ content: 'Budget preflight must reject.', role: 'user' }],
        model: providerModels.openai,
        provider: 'openai',
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    const stream = client.stream({
      maxTokens: 128,
      messages: [
        {
          content: 'Count upward slowly from one to one hundred, comma separated.',
          role: 'user',
        },
      ],
      model: providerModels.openai,
      provider: 'openai',
      temperature: 0,
    });
    stream.cancel('live-real cancellation assertion');
    expect(stream.signal.aborted).toBe(true);
  }, 30_000);

  it('does not expose API keys in normalized provider errors', async () => {
    expect(hasEnv('OPENAI_API_KEY') || hasEnv('ANTHROPIC_API_KEY') || hasEnv('GEMINI_API_KEY')).toBe(
      true,
    );
    const client = liveClient();

    try {
      await client.complete({
        maxTokens: 8,
        messages: [{ content: 'This should fail.', role: 'user' }],
        model: 'not-a-real-openai-model-live-real',
        provider: 'openai',
      });
    } catch (error) {
      expectNoSecretLeak(error);
      return;
    }

    throw new Error('Expected invalid model request to fail.');
  }, 30_000);
});
