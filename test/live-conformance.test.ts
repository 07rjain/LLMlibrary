import { describe, expect, it } from 'vitest';

import {
  assertCanonicalResponse,
  collectStream,
  hasEnv,
  liveClient,
  providerModels,
  requireLiveEnv,
  weatherTool,
} from './live-real/helpers.js';

const enabled = process.env.LIVE_CONFORMANCE === '1';
const conformanceDescribe = enabled ? describe : describe.skip;

const providers = [
  { env: 'OPENAI_API_KEY', model: providerModels.openai, name: 'openai' as const },
  {
    env: 'ANTHROPIC_API_KEY',
    model: providerModels.anthropic,
    name: 'anthropic' as const,
  },
  { env: 'GEMINI_API_KEY', model: providerModels.gemini, name: 'google' as const },
];

conformanceDescribe('live provider conformance', () => {
  for (const provider of providers) {
    it(`${provider.name} completes, streams, and reports usage`, async () => {
      requireLiveEnv(provider.env);
      const client = liveClient();
      const completion = await client.complete({
        maxTokens: 32,
        messages: [{ content: `Reply with ${provider.name.toUpperCase()}_CONFORMANCE_OK.`, role: 'user' }],
        model: provider.model,
        provider: provider.name,
        temperature: 0,
      });
      assertCanonicalResponse(completion, provider.name);
      expect(completion.text).toContain(`${provider.name.toUpperCase()}_CONFORMANCE_OK`);

      const stream = await collectStream(
        client.stream({
          maxTokens: 32,
          messages: [{ content: `Reply with ${provider.name.toUpperCase()}_STREAM_OK.`, role: 'user' }],
          model: provider.model,
          provider: provider.name,
          temperature: 0,
        }),
      );
      expect(stream.done).toBeDefined();
      expect(stream.text).toContain(`${provider.name.toUpperCase()}_STREAM_OK`);
      expect(stream.done?.usage.costUSD).toBeGreaterThanOrEqual(0);
    }, 120_000);

    it(`${provider.name} supports canonical tool calls`, async () => {
      requireLiveEnv(provider.env);
      const client = liveClient();
      const response = await client.complete({
        maxTokens: 64,
        messages: [{ content: 'Use get_weather for Paris. Do not answer from memory.', role: 'user' }],
        model: provider.model,
        provider: provider.name,
        temperature: 0,
        toolChoice: { name: 'get_weather', type: 'tool' },
        tools: [weatherTool()],
      });

      assertCanonicalResponse(response, provider.name);
      expect(response.finishReason).toBe('tool_call');
      expect(response.toolCalls[0]?.name).toBe('get_weather');
      expect(response.toolCalls[0]?.args).toBeTruthy();
    }, 120_000);
  }

  it('requires all supported provider credentials when the gate is enabled', () => {
    for (const provider of providers) {
      expect(hasEnv(provider.env), `${provider.env} is required`).toBe(true);
    }
  });
});
