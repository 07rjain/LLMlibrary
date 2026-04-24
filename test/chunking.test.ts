import { describe, expect, it } from 'vitest';

import { chunkText, cleanText, stripHtml } from '../src/chunking.js';

describe('chunking helpers', () => {
  it('returns empty output for empty text and empty html', () => {
    expect(cleanText('')).toBe('');
    expect(stripHtml('')).toBe('');
  });

  it('cleans whitespace, control characters, and zero-width characters', () => {
    expect(cleanText('  Alpha\r\nBeta\u200B   Gamma\t\tDelta\u0007  ')).toBe(
      'Alpha\nBeta Gamma Delta',
    );
  });

  it('strips HTML structure and decodes common entities', () => {
    expect(
      stripHtml(
        '<div>Hello&nbsp;<strong>world</strong></div><script>bad()</script><ul><li>One</li><li>Two &amp; three</li></ul>',
      ),
    ).toBe('Hello world\n\n- One\n- Two & three');
  });

  it('decodes named and numeric HTML entities while preserving unknown entities', () => {
    expect(
      stripHtml('<p>&lt;tag&gt; &quot;x&quot; &apos;y&apos; &#35; &#x41; &unknown;</p>'),
    ).toBe('<tag> "x" \'y\' # A &unknown;');
  });

  it('returns a single chunk for short input', () => {
    const text = 'Refunds are available for 30 days.';

    expect(chunkText(text)).toEqual([
      {
        endOffset: text.length,
        index: 0,
        startOffset: 0,
        text,
      },
    ]);
  });

  it('splits long input into overlapping chunks with stable offsets', () => {
    const cleaned =
      'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.';
    const chunks = chunkText(cleaned, {
      chunkSize: 28,
      minChunkSize: 16,
      overlap: 6,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({
      index: 0,
      startOffset: 0,
    });
    expect(chunks.at(-1)?.endOffset).toBe(cleaned.length);
    expect(chunks[1]!.startOffset).toBeLessThan(chunks[0]!.endOffset);

    for (const chunk of chunks) {
      expect(cleaned.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
  });

  it('falls back to fixed-size chunk boundaries when no natural split exists', () => {
    const chunks = chunkText('ABCDEFGHIJK', {
      chunkSize: 4,
      minChunkSize: 10,
      overlap: 10,
    });

    expect(chunks[0]).toMatchObject({
      endOffset: 4,
      startOffset: 0,
      text: 'ABCD',
    });
    expect(chunks[1]).toMatchObject({
      endOffset: 5,
      startOffset: 1,
      text: 'BCDE',
    });
    expect(chunks.at(-1)).toMatchObject({
      endOffset: 11,
      text: 'HIJK',
    });
  });

  it('returns no chunks for empty or whitespace-only input', () => {
    expect(chunkText('   \n \n')).toEqual([]);
  });
});
