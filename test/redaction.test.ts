import { describe, expect, it } from 'vitest';

import { sanitizeForLogging } from '../src/redaction.js';

describe('sanitizeForLogging key redaction', () => {
  it('redacts exact sensitive keys', () => {
    const result = sanitizeForLogging({
      apiKey: 'sk-live-secret',
      authorization: 'Bearer abc',
      cookie: 'session=xyz',
      dsn: 'postgres://u:p@host/db',
    });
    expect(result).toEqual({
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      dsn: '[REDACTED]',
    });
  });

  it('redacts provider- and context-prefixed secret fields', () => {
    const result = sanitizeForLogging({
      openaiApiKey: 'sk-openai',
      gemini_api_key: 'AIza-gemini',
      anthropicApiKey: 'sk-ant',
      dbPassword: 'hunter2',
      pgConnectionString: 'postgres://u:p@host/db',
      serviceAccountCredential: 'blob',
      userAccessToken: 'tok-123',
      refresh_token: 'tok-456',
      privateKey: '-----BEGIN KEY-----',
    });
    expect(result).toEqual({
      openaiApiKey: '[REDACTED]',
      gemini_api_key: '[REDACTED]',
      anthropicApiKey: '[REDACTED]',
      dbPassword: '[REDACTED]',
      pgConnectionString: '[REDACTED]',
      serviceAccountCredential: '[REDACTED]',
      userAccessToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
      privateKey: '[REDACTED]',
    });
  });

  it('does not redact plural token-count metric fields', () => {
    const result = sanitizeForLogging({
      inputTokens: 100,
      outputTokens: 250,
      cachedTokens: 10,
      maxTokens: 4096,
      tokenizer: 'cl100k',
    });
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 250,
      cachedTokens: 10,
      maxTokens: 4096,
      tokenizer: 'cl100k',
    });
  });

  it('does not over-redact benign keys that merely contain short fragments', () => {
    const result = sanitizeForLogging({
      dsnRegion: 'us-east-1',
      description: 'a helpful bot',
      model: 'claude-sonnet-4-6',
    });
    expect(result).toEqual({
      dsnRegion: 'us-east-1',
      description: 'a helpful bot',
      model: 'claude-sonnet-4-6',
    });
  });

  it('redacts nested prefixed secrets recursively', () => {
    const result = sanitizeForLogging({
      providerOptions: {
        gemini: { geminiApiKey: 'AIza-nested' },
      },
      list: [{ openaiApiKey: 'sk-nested' }],
    });
    expect(result).toEqual({
      providerOptions: { gemini: { geminiApiKey: '[REDACTED]' } },
      list: [{ openaiApiKey: '[REDACTED]' }],
    });
  });
});
