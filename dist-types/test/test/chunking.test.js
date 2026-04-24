import { describe, expect, it } from 'vitest';
import { chunkText, cleanText, stripHtml } from '../src/chunking.js';
describe('chunking helpers', () => {
    it('cleans whitespace, control characters, and zero-width characters', () => {
        expect(cleanText('  Alpha\r\nBeta\u200B   Gamma\t\tDelta\u0007  ')).toBe('Alpha\nBeta Gamma Delta');
    });
    it('strips HTML structure and decodes common entities', () => {
        expect(stripHtml('<div>Hello&nbsp;<strong>world</strong></div><script>bad()</script><ul><li>One</li><li>Two &amp; three</li></ul>')).toBe('Hello world\n- One\n- Two & three');
    });
    it('returns a single chunk for short input', () => {
        expect(chunkText('Refunds are available for 30 days.')).toEqual([
            {
                endOffset: 36,
                index: 0,
                startOffset: 0,
                text: 'Refunds are available for 30 days.',
            },
        ]);
    });
    it('splits long input into overlapping chunks with stable offsets', () => {
        const cleaned = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.';
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
        expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
        for (const chunk of chunks) {
            expect(cleaned.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
        }
    });
    it('returns no chunks for empty or whitespace-only input', () => {
        expect(chunkText('   \n \n')).toEqual([]);
    });
});
