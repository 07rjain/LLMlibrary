import { describe, expect, it } from 'vitest';

import { ProviderCapabilityError } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import { ModelRouter } from '../src/router.js';

import type { RouterContext } from '../src/router.js';

describe('ModelRouter', () => {
  const modelRegistry = new ModelRegistry();

  describe('Direct Routing', () => {
    it('should route directly when no rules match', () => {
      const router = new ModelRouter();
      const context = createRouterContext({ requestedModel: 'gpt-4o' });

      const result = router.resolve(context, { modelRegistry });

      expect(result.attempts.length).toBe(1);
      expect(result.attempts[0]?.model).toBe('gpt-4o');
      expect(result.attempts[0]?.provider).toBe('openai');
      expect(result.decision).toBe('requested:gpt-4o');
    });

    it('should use default model when no model is requested', () => {
      const router = new ModelRouter();
      const context = createRouterContext();

      const result = router.resolve(context, { modelRegistry, defaultModel: 'claude-sonnet-4-6' });

      expect(result.attempts[0]?.model).toBe('claude-sonnet-4-6');
      expect(result.attempts[0]?.provider).toBe('anthropic');
      expect(result.decision).toBe('default:claude-sonnet-4-6');
    });

    it('should throw when no model is available', () => {
      const router = new ModelRouter();
      const context = createRouterContext();

      expect(() => router.resolve(context, { modelRegistry })).toThrow(ProviderCapabilityError);
    });
  });

  describe('Rule Matching', () => {
    it('should match rules without conditions', () => {
      const router = new ModelRouter({
        rules: [{ name: 'default-rule', target: 'gpt-4o' }],
      });
      const context = createRouterContext();

      const result = router.resolve(context, { modelRegistry });

      expect(result.decision).toBe('rule:default-rule:primary:gpt-4o');
      expect(result.ruleName).toBe('default-rule');
    });

    it('should match rules by provider', () => {
      const router = new ModelRouter({
        rules: [
          { match: { provider: 'openai' }, name: 'openai-rule', target: 'gpt-4o-mini' },
          { match: { provider: 'anthropic' }, name: 'anthropic-rule', target: 'claude-sonnet-4-6' },
        ],
      });

      const openaiContext = createRouterContext({ requestedProvider: 'openai' });
      const anthropicContext = createRouterContext({ requestedProvider: 'anthropic' });

      const openaiResult = router.resolve(openaiContext, { modelRegistry });
      const anthropicResult = router.resolve(anthropicContext, { modelRegistry });

      expect(openaiResult.attempts[0]?.model).toBe('gpt-4o-mini');
      expect(anthropicResult.attempts[0]?.model).toBe('claude-sonnet-4-6');
    });

    it('should match rules by model', () => {
      const router = new ModelRouter({
        rules: [
          { match: { model: 'gpt-4o' }, name: 'upgrade-rule', target: 'gpt-4o-mini' },
        ],
      });
      const context = createRouterContext({ requestedModel: 'gpt-4o' });

      const result = router.resolve(context, { modelRegistry });

      expect(result.attempts[0]?.model).toBe('gpt-4o-mini');
    });

    it('should match rules by tenantId', () => {
      const router = new ModelRouter({
        rules: [
          { match: { tenantId: 'premium' }, name: 'premium-rule', target: 'gpt-4o' },
          { name: 'default-rule', target: 'gpt-4o-mini' },
        ],
      });

      const premiumContext = createRouterContext({ tenantId: 'premium' });
      const regularContext = createRouterContext({ tenantId: 'regular' });

      const premiumResult = router.resolve(premiumContext, { modelRegistry });
      const regularResult = router.resolve(regularContext, { modelRegistry });

      expect(premiumResult.attempts[0]?.model).toBe('gpt-4o');
      expect(regularResult.attempts[0]?.model).toBe('gpt-4o-mini');
    });

    it('should match rules by hasTools', () => {
      const router = new ModelRouter({
        rules: [
          { match: { hasTools: true }, name: 'tools-rule', target: 'gpt-4o' },
          { name: 'no-tools-rule', target: 'gpt-4o-mini' },
        ],
      });

      const withToolsContext = createRouterContext({
        tools: [{ name: 'test', description: 'test', parameters: { type: 'object', properties: {} } }],
      });
      const noToolsContext = createRouterContext();

      const withToolsResult = router.resolve(withToolsContext, { modelRegistry });
      const noToolsResult = router.resolve(noToolsContext, { modelRegistry });

      expect(withToolsResult.attempts[0]?.model).toBe('gpt-4o');
      expect(noToolsResult.attempts[0]?.model).toBe('gpt-4o-mini');
    });

    it('should match rules with custom function', () => {
      const router = new ModelRouter({
        rules: [
          {
            match: (ctx) => ctx.messages.some((m) => m.role === 'system'),
            name: 'system-rule',
            target: 'claude-sonnet-4-6',
          },
        ],
      });

      const withSystemContext = createRouterContext({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
      });
      const noSystemContext = createRouterContext({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const withSystemResult = router.resolve(withSystemContext, { modelRegistry });
      const noSystemResult = router.resolve(noSystemContext, { modelRegistry, defaultModel: 'gpt-4o' });

      expect(withSystemResult.attempts[0]?.model).toBe('claude-sonnet-4-6');
      expect(noSystemResult.decision).toBe('default:gpt-4o');
    });
  });

  describe('Fallback Chains', () => {
    it('should include fallback models in attempts', () => {
      const router = new ModelRouter({
        rules: [
          {
            fallback: ['claude-sonnet-4-6', 'gemini-2.5-flash'],
            name: 'chain-rule',
            target: 'gpt-4o',
          },
        ],
      });
      const context = createRouterContext();

      const result = router.resolve(context, { modelRegistry });

      expect(result.attempts.length).toBe(3);
      expect(result.attempts[0]?.model).toBe('gpt-4o');
      expect(result.attempts[1]?.model).toBe('claude-sonnet-4-6');
      expect(result.attempts[2]?.model).toBe('gemini-2.5-flash');
    });

    it('should generate correct fallback decisions', () => {
      const router = new ModelRouter({
        rules: [
          {
            fallback: ['claude-sonnet-4-6'],
            name: 'fallback-test',
            target: 'gpt-4o',
          },
        ],
      });
      const context = createRouterContext();

      const result = router.resolve(context, { modelRegistry });

      expect(result.attempts[0]?.decision).toBe('rule:fallback-test:primary:gpt-4o');
      expect(result.attempts[1]?.decision).toBe('rule:fallback-test:fallback:1:claude-sonnet-4-6');
    });

    it('should support object targets in fallback', () => {
      const router = new ModelRouter({
        rules: [
          {
            fallback: [
              { model: 'claude-sonnet-4-6', name: 'claude-backup' },
            ],
            name: 'named-fallback',
            target: { model: 'gpt-4o', name: 'primary-gpt' },
          },
        ],
      });
      const context = createRouterContext();

      const result = router.resolve(context, { modelRegistry });

      expect(result.attempts[0]?.decision).toBe('rule:named-fallback:primary:primary-gpt');
      expect(result.attempts[1]?.decision).toBe('rule:named-fallback:fallback:1:claude-backup');
    });
  });

  describe('Weighted Variants', () => {
    it('should select variant based on seed deterministically', () => {
      const router = new ModelRouter({
        rules: [
          {
            name: 'ab-test',
            variants: [
              { model: 'gpt-4o', weight: 50 },
              { model: 'claude-sonnet-4-6', weight: 50 },
            ],
          },
        ],
        seed: 'test-seed',
      });

      const context1 = createRouterContext({ sessionId: 'session-1' });
      const context2 = createRouterContext({ sessionId: 'session-2' });

      const result1a = router.resolve(context1, { modelRegistry });
      const result1b = router.resolve(context1, { modelRegistry });
      const result2 = router.resolve(context2, { modelRegistry });

      expect(result1a.attempts[0]?.model).toBe(result1b.attempts[0]?.model);
      expect(['gpt-4o', 'claude-sonnet-4-6']).toContain(result1a.attempts[0]?.model);
      expect(['gpt-4o', 'claude-sonnet-4-6']).toContain(result2.attempts[0]?.model);
    });

    it('should generate variant decisions', () => {
      const router = new ModelRouter({
        rules: [
          {
            name: 'variant-test',
            variants: [
              { model: 'gpt-4o', name: 'variant-a', weight: 100 },
            ],
          },
        ],
      });
      const context = createRouterContext();

      const result = router.resolve(context, { modelRegistry });

      expect(result.attempts[0]?.decision).toBe('rule:variant-test:variant:variant-a');
    });
  });

  describe('Provider Validation', () => {
    it('should validate model-provider consistency', () => {
      const router = new ModelRouter({
        rules: [
          {
            name: 'mismatch-rule',
            target: { model: 'gpt-4o', provider: 'anthropic' },
          },
        ],
      });
      const context = createRouterContext();

      expect(() => router.resolve(context, { modelRegistry })).toThrow(ProviderCapabilityError);
    });

    it('should infer provider from model registry', () => {
      const router = new ModelRouter({
        rules: [{ name: 'infer-rule', target: 'gemini-2.5-flash' }],
      });
      const context = createRouterContext();

      const result = router.resolve(context, { modelRegistry });

      expect(result.attempts[0]?.provider).toBe('google');
    });
  });
});

function createRouterContext(overrides: Partial<RouterContext> = {}): RouterContext {
  return {
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}
