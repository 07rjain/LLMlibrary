const DEFAULT_CHUNK_SIZE = 1_200;
const DEFAULT_MIN_CHUNK_SIZE = 300;
const DEFAULT_OVERLAP = 150;
export function cleanText(input) {
    if (input.length === 0) {
        return '';
    }
    return input
        .replace(/\r\n?/g, '\n')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\u00A0/g, ' ')
        .split('')
        .map((character) => {
        const codePoint = character.charCodeAt(0);
        return isDisallowedControlCharacter(codePoint) ? ' ' : character;
    })
        .join('')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
export function stripHtml(input) {
    if (input.length === 0) {
        return '';
    }
    const withStructure = input
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|section|article|header|footer|aside|nav|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|h[1-6])>/gi, '\n')
        .replace(/<(p|div|section|article|header|footer|aside|nav|ul|ol|table|thead|tbody|tfoot|tr|blockquote|pre|h[1-6])\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return cleanText(decodeHtmlEntities(withStructure));
}
export function chunkText(input, options = {}) {
    const normalized = cleanText(input);
    if (normalized.length === 0) {
        return [];
    }
    const chunkSize = Math.max(options.chunkSize ?? DEFAULT_CHUNK_SIZE, 1);
    const minChunkSize = Math.max(Math.min(options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE, chunkSize), 1);
    const overlap = Math.max(Math.min(options.overlap ?? DEFAULT_OVERLAP, chunkSize - 1), 0);
    const chunks = [];
    let startOffset = 0;
    while (startOffset < normalized.length) {
        const proposedEnd = Math.min(startOffset + chunkSize, normalized.length);
        const chosenEnd = proposedEnd < normalized.length
            ? findChunkBoundary(normalized, startOffset, proposedEnd, minChunkSize)
            : proposedEnd;
        const trimmedRange = trimChunkRange(normalized, startOffset, chosenEnd);
        if (trimmedRange.start >= trimmedRange.end) {
            startOffset = Math.min(normalized.length, chosenEnd + 1);
            continue;
        }
        chunks.push({
            endOffset: trimmedRange.end,
            index: chunks.length,
            startOffset: trimmedRange.start,
            text: normalized.slice(trimmedRange.start, trimmedRange.end),
        });
        if (chosenEnd >= normalized.length) {
            break;
        }
        const nextBase = Math.max(chosenEnd - overlap, startOffset + 1);
        startOffset = skipLeadingWhitespace(normalized, nextBase);
    }
    return chunks;
}
function decodeHtmlEntities(input) {
    return input.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (match, entity) => {
        switch (entity) {
            case 'amp':
                return '&';
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
            case 'nbsp':
                return ' ';
            default:
                if (entity.startsWith('#x') || entity.startsWith('#X')) {
                    const codePoint = Number.parseInt(entity.slice(2), 16);
                    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
                }
                if (entity.startsWith('#')) {
                    const codePoint = Number.parseInt(entity.slice(1), 10);
                    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
                }
                return match;
        }
    });
}
function findChunkBoundary(input, startOffset, proposedEnd, minChunkSize) {
    const minimumEnd = Math.min(startOffset + minChunkSize, proposedEnd);
    for (const pattern of ['\n\n', '. ', '! ', '? ', '\n', ' ']) {
        const index = input.lastIndexOf(pattern, proposedEnd - 1);
        if (index >= minimumEnd) {
            return index + pattern.length;
        }
    }
    return proposedEnd;
}
function isDisallowedControlCharacter(codePoint) {
    return ((codePoint >= 0x00 && codePoint <= 0x08) ||
        (codePoint >= 0x0b && codePoint <= 0x1f) ||
        codePoint === 0x7f);
}
function isWhitespaceCharacter(character) {
    return character === ' ' || character === '\n' || character === '\t';
}
function skipLeadingWhitespace(input, startOffset) {
    let offset = startOffset;
    while (offset < input.length && isWhitespaceCharacter(input[offset])) {
        offset += 1;
    }
    return offset;
}
function trimChunkRange(input, startOffset, endOffset) {
    let start = startOffset;
    let end = endOffset;
    while (start < end && isWhitespaceCharacter(input[start])) {
        start += 1;
    }
    while (end > start && isWhitespaceCharacter(input[end - 1])) {
        end -= 1;
    }
    return { end, start };
}
