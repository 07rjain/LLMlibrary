import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  BudgetExceededError,
  ContextLimitError,
  InvalidConversationSnapshotError,
  LLMError,
  MaxToolRoundsError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../src/errors.js';

describe('LLMError hierarchy', () => {
  it('preserves metadata and serializes cleanly', () => {
    const error = new LLMError('boom', {
      cause: new Error('root'),
      details: { feature: 'tools' },
      model: 'gpt-4o',
      provider: 'openai',
      requestId: 'req_123',
      retryable: true,
      statusCode: 429,
    });

    expect(error.toJSON()).toMatchObject({
      details: { feature: 'tools' },
      message: 'boom',
      model: 'gpt-4o',
      name: 'LLMError',
      provider: 'openai',
      requestId: 'req_123',
      retryable: true,
      statusCode: 429,
    });
  });

  it('redacts credentials when serialized', () => {
    const error = new LLMError('Bearer sk-secret-value failed', {
      cause: new Error('postgresql://user:password@example.test/app'),
      details: {
        authorization: 'Bearer sk-secret-value',
        connectionString: 'postgresql://user:password@example.test/app',
      },
    });

    expect(error.toJSON()).toMatchObject({
      cause: expect.objectContaining({
        message: 'postgresql://[REDACTED]@example.test/app',
      }),
      details: {
        authorization: '[REDACTED]',
        connectionString: '[REDACTED]',
      },
      message: 'Bearer [REDACTED] failed',
    });
  });

  it('exports typed subclasses', () => {
    expect(new AuthenticationError('auth')).toBeInstanceOf(LLMError);
    expect(new RateLimitError('rate')).toBeInstanceOf(LLMError);
    expect(new ContextLimitError('context')).toBeInstanceOf(LLMError);
    expect(new ProviderCapabilityError('capability')).toBeInstanceOf(LLMError);
    expect(new BudgetExceededError('budget')).toBeInstanceOf(LLMError);
    expect(new MaxToolRoundsError('rounds')).toBeInstanceOf(LLMError);
    expect(
      new InvalidConversationSnapshotError('snapshot.messages', 'dense_array'),
    ).toBeInstanceOf(LLMError);
    expect(new ProviderError('provider')).toBeInstanceOf(LLMError);
  });

  it('keeps invalid snapshot errors stable and sanitized', () => {
    const error = new InvalidConversationSnapshotError(
      'snapshot.totalInputTokens',
      'finite_non_negative_safe_integer',
    );

    expect(error.toJSON()).toMatchObject({
      details: {
        code: 'invalid_conversation_snapshot',
        constraint: 'finite_non_negative_safe_integer',
        path: 'snapshot.totalInputTokens',
      },
      message: 'Conversation snapshot is invalid.',
      name: 'InvalidConversationSnapshotError',
      retryable: false,
      statusCode: 400,
    });
  });
});
