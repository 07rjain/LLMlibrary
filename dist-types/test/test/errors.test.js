import { describe, expect, it } from 'vitest';
import { AuthenticationError, BudgetExceededError, ContextLimitError, LLMError, MaxToolRoundsError, ProviderCapabilityError, ProviderError, RateLimitError, } from '../src/errors.js';
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
    it('exports typed subclasses', () => {
        expect(new AuthenticationError('auth')).toBeInstanceOf(LLMError);
        expect(new RateLimitError('rate')).toBeInstanceOf(LLMError);
        expect(new ContextLimitError('context')).toBeInstanceOf(LLMError);
        expect(new ProviderCapabilityError('capability')).toBeInstanceOf(LLMError);
        expect(new BudgetExceededError('budget')).toBeInstanceOf(LLMError);
        expect(new MaxToolRoundsError('rounds')).toBeInstanceOf(LLMError);
        expect(new ProviderError('provider')).toBeInstanceOf(LLMError);
    });
});
