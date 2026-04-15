import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../src/models/registry.js';
import { ModelRouter } from '../src/router.js';

describe('ModelRouter', () => {
  const modelRegistry = new ModelRegistry(undefined, {
    emitStalenessWarning: false,
  });

  it('applies ordered rules and preserves fallback chains', () => {
    const router = new ModelRouter({
      rules: [
        {
          match: { hasTools: true },
          name: 'tools-first',
          target: 'gpt-4o',
          fallback: ['claude-sonnet-4-6'],
        },
        {
          name: 'default-flash',
          target: 'gemini-2.5-flash',
        },
      ],
    });

    const resolved = router.resolve(
      {
        maxTokens: 256,
        messages: [{ content: 'Use a tool', role: 'user' }],
        tools: [
          {
            description: 'Look up weather',
            name: 'lookup_weather',
            parameters: {
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
              type: 'object',
            },
          },
        ],
      },
      {
        defaultModel: 'gemini-2.5-flash',
        modelRegistry,
      },
    );

    expect(resolved.attempts).toEqual([
      {
        decision: 'rule:tools-first:primary:gpt-4o',
        model: 'gpt-4o',
        provider: 'openai',
      },
      {
        decision: 'rule:tools-first:fallback:1:claude-sonnet-4-6',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      },
    ]);
  });

  it('uses seeded weighted A/B routing deterministically', () => {
    const router = new ModelRouter({
      rules: [
        {
          name: 'ab-test',
          variants: [
            { model: 'gpt-4o', weight: 1 },
            { model: 'gpt-4o-mini', weight: 1 },
          ],
        },
      ],
      seed: 'router-seed',
    });

    const first = router.resolve(
      {
        maxTokens: 256,
        messages: [{ content: 'Hello there', role: 'user' }],
        sessionId: 'session-a',
      },
      {
        defaultModel: 'gpt-4o',
        modelRegistry,
      },
    );
    const second = router.resolve(
      {
        maxTokens: 256,
        messages: [{ content: 'Hello there', role: 'user' }],
        sessionId: 'session-a',
      },
      {
        defaultModel: 'gpt-4o',
        modelRegistry,
      },
    );

    expect(second.attempts[0]).toEqual(first.attempts[0]);

    const observedModels = new Set(
      Array.from({ length: 20 }, (_, index) =>
        router.resolve(
          {
            maxTokens: 256,
            messages: [{ content: 'Hello there', role: 'user' }],
            sessionId: `session-${index}`,
          },
          {
            defaultModel: 'gpt-4o',
            modelRegistry,
          },
        ).attempts[0]?.model,
      ),
    );

    expect(observedModels).toEqual(new Set(['gpt-4o', 'gpt-4o-mini']));
  });

  it('falls back to direct requested models when no rule matches', () => {
    const router = new ModelRouter({
      rules: [
        {
          match: { tenantId: 'tenant-1' },
          name: 'tenant-specific',
          target: 'gpt-4o',
        },
      ],
    });

    const resolved = router.resolve(
      {
        maxTokens: 128,
        messages: [{ content: 'Hello', role: 'user' }],
        requestedModel: 'gemini-2.5-flash',
        tenantId: 'tenant-2',
      },
      {
        modelRegistry,
      },
    );

    expect(resolved.attempts).toEqual([
      {
        decision: 'requested:gemini-2.5-flash',
        model: 'gemini-2.5-flash',
        provider: 'google',
      },
    ]);
  });

  it('supports function matchers and direct targets inside matched rules', () => {
    const router = new ModelRouter({
      rules: [
        {
          match: (context) => context.sessionId === 'session-1',
          name: 'function-match',
        },
      ],
    });

    const resolved = router.resolve(
      {
        maxTokens: 128,
        messages: [{ content: 'Hello', role: 'user' }],
        requestedModel: 'gpt-4o',
        sessionId: 'session-1',
      },
      {
        modelRegistry,
      },
    );

    expect(resolved.attempts[0]).toEqual({
      decision: 'rule:function-match:primary:gpt-4o',
      model: 'gpt-4o',
      provider: 'openai',
    });
  });

  it('matches compound filter rules and supports default-model routing', () => {
    const compoundRouter = new ModelRouter({
      rules: [
        {
          match: {
            hasTools: false,
            model: 'gpt-4o',
            provider: 'openai',
            sessionId: 'session-1',
            tenantId: 'tenant-1',
          },
          name: 'compound-filter',
          target: 'gpt-4o-mini',
        },
      ],
    });
    const defaultRouter = new ModelRouter();

    const compoundResolved = compoundRouter.resolve(
      {
        maxTokens: 128,
        messages: [{ content: 'Hello', role: 'user' }],
        requestedModel: 'gpt-4o',
        requestedProvider: 'openai',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
      },
      {
        modelRegistry,
      },
    );
    const defaultResolved = defaultRouter.resolve(
      {
        maxTokens: 128,
        messages: [{ content: 'Hello', role: 'user' }],
      },
      {
        defaultModel: 'gpt-4o',
        defaultProvider: 'openai',
        modelRegistry,
      },
    );

    expect(compoundResolved.attempts[0]).toEqual({
      decision: 'rule:compound-filter:primary:gpt-4o-mini',
      model: 'gpt-4o-mini',
      provider: 'openai',
    });
    expect(defaultResolved.attempts[0]).toEqual({
      decision: 'default:gpt-4o',
      model: 'gpt-4o',
      provider: 'openai',
    });
  });

  it('builds deterministic routing seeds from structured message content', () => {
    const router = new ModelRouter({
      rules: [
        {
          name: 'structured-ab',
          variants: [
            { model: 'gpt-4o', weight: 1 },
            { model: 'gpt-4o-mini', weight: 1 },
          ],
        },
      ],
      seed: 'structured-seed',
    });

    const resolved = router.resolve(
      {
        maxTokens: 128,
        messages: [
          {
            content: [
              { text: 'Look this up', type: 'text' },
              {
                args: { city: 'Berlin' },
                id: 'tool_1',
                name: 'lookup_weather',
                type: 'tool_call',
              },
              {
                name: 'lookup_weather',
                result: { forecast: 'Sunny' },
                toolCallId: 'tool_1',
                type: 'tool_result',
              },
              {
                type: 'image_url',
                url: 'https://example.test/image.png',
              },
            ],
            role: 'user',
          },
        ],
        sessionId: 'structured-session',
      },
      {
        defaultModel: 'gpt-4o',
        modelRegistry,
      },
    );

    expect(resolved.attempts[0]?.model).toMatch(/gpt-4o/);
  });

  it('throws when a matched rule has no route target and no default model', () => {
    const router = new ModelRouter({
      rules: [
        {
          name: 'missing-target',
        },
      ],
    });

    expect(() =>
      router.resolve(
        {
          maxTokens: 128,
          messages: [{ content: 'Hello', role: 'user' }],
        },
        {
          modelRegistry,
        },
      ),
    ).toThrow('no target model was available');
  });

  it('throws on invalid route definitions', () => {
    const invalidWeights = new ModelRouter({
      rules: [
        {
          name: 'bad-weights',
          variants: [{ model: 'gpt-4o', weight: 0 }],
        },
      ],
    });
    const invalidProvider = new ModelRouter({
      rules: [
        {
          name: 'bad-provider',
          target: {
            model: 'gpt-4o',
            provider: 'anthropic',
          },
        },
      ],
    });

    expect(() =>
      invalidWeights.resolve(
        {
          maxTokens: 128,
          messages: [{ content: 'Hello', role: 'user' }],
        },
        {
          modelRegistry,
        },
      ),
    ).toThrow('invalid variant weights');
    expect(() =>
      invalidProvider.resolve(
        {
          maxTokens: 128,
          messages: [{ content: 'Hello', role: 'user' }],
        },
        {
          modelRegistry,
        },
      ),
    ).toThrow('belongs to provider');
  });

  it('throws when a direct requested provider does not match the model provider', () => {
    const router = new ModelRouter();

    expect(() =>
      router.resolve(
        {
          maxTokens: 128,
          messages: [{ content: 'Hello', role: 'user' }],
          requestedModel: 'gpt-4o',
          requestedProvider: 'anthropic',
        },
        {
          modelRegistry,
        },
      ),
    ).toThrow('belongs to provider');
  });
});
