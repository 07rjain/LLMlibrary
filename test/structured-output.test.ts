import { describe, expect, it } from 'vitest';

import { ProviderCapabilityError } from '../src/errors.js';
import {
  buildAnthropicOutputConfig,
  normalizeStructuredSchema,
  parseStructuredOutput,
} from '../src/structured-output.js';

describe('structured output helpers', () => {
  it('normalizes OpenAI strict schemas before dispatch', () => {
    expect(
      normalizeStructuredSchema(
        {
          properties: {
            answer: { type: 'string' },
            count: { type: 'integer' },
          },
          required: ['answer'],
          type: 'object',
        },
        'openai',
        { root: true, strict: true },
      ),
    ).toEqual({
      additionalProperties: false,
      properties: {
        answer: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['answer', 'count'],
      type: 'object',
    });
  });

  it('rejects intentionally unsupported v1 schema keywords', () => {
    expect(() =>
      normalizeStructuredSchema(
        {
          properties: {
            answer: { title: 'Answer', type: 'string' },
          },
          type: 'object',
        },
        'openai',
        { root: true, strict: true },
      ),
    ).toThrow(ProviderCapabilityError);
  });

  it('does not parse provider refusals as malformed JSON', () => {
    const response = parseStructuredOutput(
      {
        content: [{ text: 'I cannot help with that.', type: 'text' }],
        finishReason: 'content_filter',
        model: 'gpt-4o',
        provider: 'openai',
        raw: {},
        refusal: 'I cannot help with that.',
        structuredOutputStatus: 'refusal',
        text: 'I cannot help with that.',
        toolCalls: [],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      },
      {
        schema: { properties: { ok: { type: 'boolean' } }, type: 'object' },
        type: 'json_schema',
      },
    );

    expect(response.structuredOutputStatus).toBe('refusal');
    expect(response.parseError).toBeUndefined();
    expect(response.responseFormat).toBe('json_schema');
  });

  it('keeps Anthropic json_object unsupported without a schema', () => {
    expect(() => buildAnthropicOutputConfig({ type: 'json_object' })).toThrow(
      ProviderCapabilityError,
    );
  });
});
