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

  it('redacts prompts, messages, explicit tool data, and raw payloads', () => {
    const result = sanitizeForLogging({
      messages: [{ content: 'message-canary', role: 'user' }],
      prompt: 'prompt-canary',
      raw_body: 'raw-body-snake-canary',
      rawBody: 'raw-body-canary',
      rawRequest: { body: 'request-canary' },
      responseBody: 'response-canary',
      systemPrompt: 'system-canary',
      toolArgs: { query: 'args-canary' },
      toolCalls: [{ arguments: 'call-canary' }],
      toolPayload: { value: 'payload-canary' },
      toolResults: ['result-canary'],
      transcript: 'transcript-canary',
      user_prompt: 'user-canary',
    });

    expect(Object.values(result).every((value) => value === '[REDACTED]')).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /(?:message|prompt|request|response|system|args|call|payload|result|transcript|user)-canary/,
    );
  });

  it('preserves safe metrics and benign attribution fields', () => {
    const result = sanitizeForLogging({
      contentType: 'application/json',
      body: 'body-visible',
      content: 'content-visible',
      data: 'data-visible',
      feature: 'ticket-summary',
      inputTokens: 100,
      maxTokens: 4096,
      outputTokens: 25,
      promptTokens: 100,
      provider: 'openai',
      request: 'request-visible',
      requestId: 'request-1',
      response: 'response-visible',
      tokenizer: 'cl100k',
      toolRound: 2,
    });

    expect(result).toEqual({
      contentType: 'application/json',
      body: 'body-visible',
      content: 'content-visible',
      data: 'data-visible',
      feature: 'ticket-summary',
      inputTokens: 100,
      maxTokens: 4096,
      outputTokens: 25,
      promptTokens: 100,
      provider: 'openai',
      request: 'request-visible',
      requestId: 'request-1',
      response: 'response-visible',
      tokenizer: 'cl100k',
      toolRound: 2,
    });
  });

  it('does not enumerate binary values or retain encoded media', () => {
    const bytes = new Uint8Array([115, 101, 99, 114, 101, 116]);
    const longBase64 = Buffer.from('binary-canary'.repeat(60)).toString(
      'base64',
    );
    const chunks = longBase64.match(/.{1,64}/g) ?? [];
    const result = sanitizeForLogging({
      arbitraryBytes: bytes,
      buffer: bytes.buffer,
      crlfWrapped: `\r\n${chunks.join('\r\n')}\r\n`,
      generic: longBase64,
      imageUrl: 'https://example.test/private.png',
      inline: 'data:audio/wav;base64,Y2FuYXJ5',
      newlineWrapped: chunks.join('\n'),
      spaceWrapped: ` ${chunks.join(' ')} `,
    });

    expect(result).toEqual({
      arbitraryBytes: '[REDACTED]',
      buffer: '[REDACTED]',
      crlfWrapped: '[REDACTED]',
      generic: '[REDACTED]',
      imageUrl: '[REDACTED]',
      inline: '[REDACTED]',
      newlineWrapped: '[REDACTED]',
      spaceWrapped: '[REDACTED]',
    });
    expect(JSON.stringify(result)).not.toContain('binary-canary');
  });

  it('preserves ordinary multiline text and wrapped near-misses', () => {
    const multiline = 'ordinary multiline words\n'.repeat(30);
    const nearMiss = `${'QUJD'.repeat(20)}\n${'REVG'.repeat(20)}*`;
    const result = sanitizeForLogging({
      body: multiline,
      data: nearMiss,
      request: multiline,
      response: nearMiss,
    });

    expect(result).toEqual({
      body: multiline,
      data: nearMiss,
      request: multiline,
      response: nearMiss,
    });
  });

  it('sanitizes a large base64 fixture without retaining its contents', () => {
    const payload = Buffer.alloc(700_000, 97).toString('base64');
    const startedAt = performance.now();
    const result = sanitizeForLogging({ data: payload });

    expect(result).toEqual({ data: '[REDACTED]' });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
