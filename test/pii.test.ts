import { describe, expect, it } from 'vitest';

import {
  redactPII,
  redactPIIFromMessages,
  redactPIIInJson,
} from '../src/pii.js';

import type { CanonicalMessage } from '../src/types.js';

describe('PII redaction', () => {
  it('redacts email, phone, and Luhn-valid card values', () => {
    const result = redactPII(
      'Email jane@example.com, call +1 (415) 555-2671, card 4242 4242 4242 4242.',
    );

    expect(result.text).toBe(
      'Email [REDACTED_EMAIL], call [REDACTED_PHONE], card [REDACTED_CREDIT_CARD].',
    );
    expect(result.summary.byKind).toEqual({
      credit_card: 1,
      email: 1,
      phone: 1,
    });
    expect(result.summary.total).toBe(3);
    expect(JSON.stringify(result.summary)).not.toContain('jane@example.com');
    expect(JSON.stringify(result.summary)).not.toContain('4242 4242');
  });

  it('does not treat ISO dates as phone numbers', () => {
    expect(redactPII('Created on 2026-07-14.').text).toBe(
      'Created on 2026-07-14.',
    );
  });

  it('can require Luhn validation for card-only scanning', () => {
    const result = redactPII('Card 4242 4242 4242 4241.', {
      kinds: ['credit_card'],
    });

    expect(result.text).toBe('Card 4242 4242 4242 4241.');
    expect(result.summary.total).toBe(0);
  });

  it('stops a card match before a following numeric field', () => {
    const result = redactPII('Card 4242 4242 4242 4242 20260714.');

    expect(result.text).toBe('Card [REDACTED_CREDIT_CARD] 20260714.');
    expect(result.summary.byKind.credit_card).toBe(1);
  });

  it('does not leave a suffix from a valid 19-digit card visible', () => {
    const result = redactPII('Card 4242424242424242006.', {
      kinds: ['credit_card'],
    });

    expect(result.text).toBe('Card [REDACTED_CREDIT_CARD].');
  });

  it('allows Luhn validation and replacement markers to be configured', () => {
    const result = redactPII('Reference 4242-4242-4242-4241', {
      kinds: ['credit_card'],
      replacements: { credit_card: '<card>' },
      validateCreditCards: false,
    });

    expect(result.text).toBe('Reference <card>');
    expect(result.summary.occurrences[0]).toMatchObject({
      kind: 'credit_card',
      replacement: '<card>',
    });
  });

  it('supports configurable phone digit limits', () => {
    expect(
      redactPII('Extension 555-2671', {
        kinds: ['phone'],
        phone: { minDigits: 10 },
      }).text,
    ).toBe('Extension 555-2671');

    expect(() =>
      redactPII('Call 555-2671', {
        kinds: ['phone'],
        phone: { maxDigits: 2, minDigits: 3 },
      }),
    ).toThrow(RangeError);
  });

  it('recursively redacts JSON and reports paths without raw values', () => {
    const result = redactPIIInJson({
      'owner@example.com': 'Email backup@example.com',
      customer: {
        contacts: ['owner@example.com', '+44 20 7946 0958'],
      },
      keep: 42,
    });

    expect(result.value).toEqual({
      'owner@example.com': 'Email [REDACTED_EMAIL]',
      customer: {
        contacts: ['[REDACTED_EMAIL]', '[REDACTED_PHONE]'],
      },
      keep: 42,
    });
    expect(result.summary.occurrences.map(({ path }) => path)).toEqual([
      '$[key:0]',
      '$.customer.contacts[0]',
      '$.customer.contacts[1]',
    ]);
    expect(JSON.stringify(result.summary)).not.toContain('owner@example.com');
  });

  it('redacts message text and structured tool data but not media or URLs', () => {
    const messages: CanonicalMessage[] = [
      { content: 'Contact me at user@example.com', role: 'user' },
      {
        content: [
          { text: 'Call +91 98765 43210', type: 'text' },
          {
            args: { email: 'tool@example.com' },
            id: 'call-1',
            name: 'save_contact',
            type: 'tool_call',
          },
          {
            result: { phone: '+1 212 555 0100' },
            toolCallId: 'call-1',
            type: 'tool_result',
          },
          {
            data: 'user@example.com',
            mediaType: 'image/png',
            type: 'image_base64',
          },
          {
            type: 'image_url',
            url: 'https://example.test/user@example.com.png',
          },
        ],
        role: 'assistant',
      },
    ];

    const result = redactPIIFromMessages(messages);

    expect(result.messages[0]?.content).toBe('Contact me at [REDACTED_EMAIL]');
    expect(result.messages[1]?.content).toEqual([
      { text: 'Call [REDACTED_PHONE]', type: 'text' },
      {
        args: { email: '[REDACTED_EMAIL]' },
        id: 'call-1',
        name: 'save_contact',
        type: 'tool_call',
      },
      {
        result: { phone: '[REDACTED_PHONE]' },
        toolCallId: 'call-1',
        type: 'tool_result',
      },
      {
        data: 'user@example.com',
        mediaType: 'image/png',
        type: 'image_base64',
      },
      {
        type: 'image_url',
        url: 'https://example.test/user@example.com.png',
      },
    ]);
    expect(messages[0]?.content).toBe('Contact me at user@example.com');
    expect(result.summary.total).toBe(4);
  });

  it('leaves primitive JSON values unchanged', () => {
    expect(redactPIIInJson(null).value).toBeNull();
    expect(redactPIIInJson(true).value).toBe(true);
    expect(redactPIIInJson(12).value).toBe(12);
  });
});
