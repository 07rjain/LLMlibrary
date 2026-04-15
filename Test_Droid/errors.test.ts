import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  BudgetExceededError,
  ContextLimitError,
  LLMError,
  MaxToolRoundsError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../src/errors.js';

describe('Error Classes', () => {
  describe('LLMError (Base)', () => {
    it('should create error with message only', () => {
      const error = new LLMError('Test error');

      expect(error.message).toBe('Test error');
      expect(error.name).toBe('LLMError');
      expect(error.retryable).toBe(false);
      expect(error.cause).toBeUndefined();
      expect(error.model).toBeUndefined();
      expect(error.provider).toBeUndefined();
    });

    it('should create error with all options', () => {
      const cause = new Error('Original error');
      const error = new LLMError('Test error', {
        cause,
        details: { key: 'value' },
        model: 'gpt-4o',
        provider: 'openai',
        requestId: 'req_123',
        retryable: true,
        statusCode: 500,
      });

      expect(error.message).toBe('Test error');
      expect(error.cause).toBe(cause);
      expect(error.details).toEqual({ key: 'value' });
      expect(error.model).toBe('gpt-4o');
      expect(error.provider).toBe('openai');
      expect(error.requestId).toBe('req_123');
      expect(error.retryable).toBe(true);
      expect(error.statusCode).toBe(500);
    });

    it('should serialize to JSON correctly', () => {
      const error = new LLMError('Test error', {
        model: 'gpt-4o',
        provider: 'openai',
        statusCode: 400,
        retryable: false,
      });

      const json = error.toJSON();

      expect(json).toEqual({
        cause: undefined,
        details: undefined,
        message: 'Test error',
        model: 'gpt-4o',
        name: 'LLMError',
        provider: 'openai',
        requestId: undefined,
        retryable: false,
        statusCode: 400,
      });
    });

    it('should be instanceof Error', () => {
      const error = new LLMError('Test');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(LLMError);
    });
  });

  describe('AuthenticationError', () => {
    it('should have correct name', () => {
      const error = new AuthenticationError('Invalid API key');
      expect(error.name).toBe('AuthenticationError');
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(AuthenticationError);
    });

    it('should work with provider info', () => {
      const error = new AuthenticationError('API key missing', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      expect(error.provider).toBe('anthropic');
      expect(error.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('RateLimitError', () => {
    it('should have correct name', () => {
      const error = new RateLimitError('Rate limit exceeded');
      expect(error.name).toBe('RateLimitError');
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(RateLimitError);
    });

    it('should support retryable flag', () => {
      const error = new RateLimitError('Too many requests', {
        retryable: true,
        statusCode: 429,
      });

      expect(error.retryable).toBe(true);
      expect(error.statusCode).toBe(429);
    });
  });

  describe('ContextLimitError', () => {
    it('should have correct name', () => {
      const error = new ContextLimitError('Context window exceeded');
      expect(error.name).toBe('ContextLimitError');
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(ContextLimitError);
    });

    it('should include token details', () => {
      const error = new ContextLimitError('Token limit exceeded', {
        details: {
          maxTokens: 8192,
          requestedTokens: 10000,
        },
        model: 'gpt-4o',
      });

      expect(error.details?.maxTokens).toBe(8192);
      expect(error.details?.requestedTokens).toBe(10000);
    });
  });

  describe('ProviderCapabilityError', () => {
    it('should have correct name', () => {
      const error = new ProviderCapabilityError('Vision not supported');
      expect(error.name).toBe('ProviderCapabilityError');
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(ProviderCapabilityError);
    });

    it('should describe missing capability', () => {
      const error = new ProviderCapabilityError('Tool calling not supported', {
        provider: 'cohere',
        model: 'command-r',
        details: { capability: 'tools' },
      });

      expect(error.provider).toBe('cohere');
      expect(error.details?.capability).toBe('tools');
    });
  });

  describe('BudgetExceededError', () => {
    it('should have correct name', () => {
      const error = new BudgetExceededError('Budget exceeded');
      expect(error.name).toBe('BudgetExceededError');
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(BudgetExceededError);
    });

    it('should include budget details', () => {
      const error = new BudgetExceededError('Request would exceed budget', {
        details: {
          budgetUsd: 0.5,
          estimatedCostUSD: 0.75,
        },
      });

      expect(error.details?.budgetUsd).toBe(0.5);
      expect(error.details?.estimatedCostUSD).toBe(0.75);
    });
  });

  describe('MaxToolRoundsError', () => {
    it('should have correct name', () => {
      const error = new MaxToolRoundsError('Max tool rounds exceeded');
      expect(error.name).toBe('MaxToolRoundsError');
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(MaxToolRoundsError);
    });

    it('should include round info', () => {
      const error = new MaxToolRoundsError('Exceeded 5 rounds', {
        model: 'gpt-4o',
        provider: 'openai',
      });

      expect(error.model).toBe('gpt-4o');
      expect(error.provider).toBe('openai');
    });
  });

  describe('ProviderError', () => {
    it('should have correct name', () => {
      const error = new ProviderError('Provider unavailable');
      expect(error.name).toBe('ProviderError');
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toBeInstanceOf(ProviderError);
    });

    it('should wrap provider-specific errors', () => {
      const originalError = new Error('Connection timeout');
      const error = new ProviderError('Failed to connect to OpenAI', {
        cause: originalError,
        provider: 'openai',
        statusCode: 503,
        retryable: true,
      });

      expect(error.cause).toBe(originalError);
      expect(error.statusCode).toBe(503);
      expect(error.retryable).toBe(true);
    });
  });

  describe('Error Type Checking', () => {
    it('should allow type narrowing with instanceof', () => {
      const errors: LLMError[] = [
        new AuthenticationError('Auth failed'),
        new RateLimitError('Rate limited'),
        new BudgetExceededError('Over budget'),
      ];

      for (const error of errors) {
        if (error instanceof AuthenticationError) {
          expect(error.name).toBe('AuthenticationError');
        } else if (error instanceof RateLimitError) {
          expect(error.name).toBe('RateLimitError');
        } else if (error instanceof BudgetExceededError) {
          expect(error.name).toBe('BudgetExceededError');
        }
      }
    });

    it('should preserve prototype chain', () => {
      const error = new AuthenticationError('Test');

      expect(Object.getPrototypeOf(error)).toBe(AuthenticationError.prototype);
      expect(Object.getPrototypeOf(Object.getPrototypeOf(error))).toBe(LLMError.prototype);
      expect(Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf(error)))).toBe(
        Error.prototype,
      );
    });
  });
});
