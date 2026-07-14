const ALL_KINDS = [
    'credit_card',
    'email',
    'phone',
];
const DEFAULT_REPLACEMENTS = {
    credit_card: '[REDACTED_CREDIT_CARD]',
    email: '[REDACTED_EMAIL]',
    phone: '[REDACTED_PHONE]',
};
/**
 * Redacts common PII patterns without returning the matched values in metadata.
 * Pattern matching is best-effort and is not a substitute for a compliance DLP.
 */
export function redactPII(text, options = {}) {
    return redactTextAtPath(text, options);
}
/** Recursively redacts strings in JSON-compatible tool inputs and outputs. */
export function redactPIIInJson(value, options = {}) {
    const occurrences = [];
    const redacted = redactJsonValue(value, options, '$', occurrences);
    return {
        summary: summarize(occurrences),
        value: redacted,
    };
}
/**
 * Returns cloned messages with text, tool-call arguments, and tool results
 * redacted. Binary data and URL/document parts are left unchanged.
 */
export function redactPIIFromMessages(messages, options = {}) {
    const occurrences = [];
    const redactedMessages = messages.map((message, messageIndex) => {
        const contentPath = `$[${messageIndex}].content`;
        if (typeof message.content === 'string') {
            const result = redactTextAtPath(message.content, options, contentPath);
            occurrences.push(...result.summary.occurrences);
            return { ...message, content: result.text };
        }
        return {
            ...message,
            content: message.content.map((part, partIndex) => redactPart(part, options, `${contentPath}[${partIndex}]`, occurrences)),
        };
    });
    return {
        messages: redactedMessages,
        summary: summarize(occurrences),
    };
}
function redactPart(part, options, path, occurrences) {
    switch (part.type) {
        case 'text': {
            const result = redactTextAtPath(part.text, options, `${path}.text`);
            occurrences.push(...result.summary.occurrences);
            return { ...part, text: result.text };
        }
        case 'tool_call':
            return {
                ...part,
                args: redactJsonValue(part.args, options, `${path}.args`, occurrences),
            };
        case 'tool_result':
            return {
                ...part,
                result: redactJsonValue(part.result, options, `${path}.result`, occurrences),
            };
        default:
            return { ...part };
    }
}
function redactJsonValue(value, options, path, occurrences) {
    if (typeof value === 'string') {
        const result = redactTextAtPath(value, options, path);
        occurrences.push(...result.summary.occurrences);
        return result.text;
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => redactJsonValue(item, options, `${path}[${index}]`, occurrences));
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, entry], index) => [
            key,
            redactJsonValue(entry, options, appendObjectPath(path, key, index), occurrences),
        ]));
    }
    return value;
}
function appendObjectPath(path, key, index) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        ? `${path}.${key}`
        : `${path}[key:${index}]`;
}
function redactTextAtPath(text, options, path) {
    const kinds = new Set(options.kinds ?? ALL_KINDS);
    const ranges = [];
    if (kinds.has('credit_card')) {
        addCreditCardRanges(text, ranges, options.validateCreditCards ?? true);
    }
    if (kinds.has('email')) {
        addEmailRanges(text, ranges);
    }
    if (kinds.has('phone')) {
        addPhoneRanges(text, ranges, options.phone?.minDigits ?? 7, options.phone?.maxDigits ?? 15);
    }
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    const occurrences = [];
    const chunks = [];
    let cursor = 0;
    for (const range of ranges) {
        const replacement = options.replacements?.[range.kind] ?? DEFAULT_REPLACEMENTS[range.kind];
        chunks.push(text.slice(cursor, range.start), replacement);
        occurrences.push({
            end: range.end,
            kind: range.kind,
            ...(path ? { path } : {}),
            replacement,
            start: range.start,
        });
        cursor = range.end;
    }
    chunks.push(text.slice(cursor));
    return {
        summary: summarize(occurrences),
        text: chunks.join(''),
    };
}
function addEmailRanges(text, ranges) {
    const pattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
    for (const match of text.matchAll(pattern)) {
        addRange(ranges, {
            end: match.index + match[0].length,
            kind: 'email',
            start: match.index,
        });
    }
}
function addCreditCardRanges(text, ranges, validate) {
    const preferredLengths = [19, 18, 17, 16, 15, 14, 13];
    for (let start = 0; start < text.length; start += 1) {
        if (!isDigit(text[start])) {
            continue;
        }
        if (isDigit(text[start - 1]) ||
            ((text[start - 1] === ' ' || text[start - 1] === '-') &&
                isDigit(text[start - 2]))) {
            continue;
        }
        const digitEnds = [];
        let cursor = start;
        while (cursor < text.length && digitEnds.length < 19) {
            if (isDigit(text[cursor])) {
                digitEnds.push(cursor + 1);
                cursor += 1;
                continue;
            }
            if ((text[cursor] === ' ' || text[cursor] === '-') &&
                isDigit(text[cursor + 1])) {
                cursor += 1;
                continue;
            }
            break;
        }
        const length = preferredLengths.find((candidateLength) => {
            const end = digitEnds[candidateLength - 1];
            if (end === undefined) {
                return false;
            }
            if (isDigit(text[end])) {
                return false;
            }
            const digits = digitsOnly(text.slice(start, end));
            return !validate || passesLuhn(digits);
        });
        if (length === undefined) {
            continue;
        }
        const end = digitEnds[length - 1];
        addRange(ranges, { end, kind: 'credit_card', start });
        start = end - 1;
    }
}
function addPhoneRanges(text, ranges, minDigits, maxDigits) {
    if (minDigits < 3 || maxDigits < minDigits) {
        throw new RangeError('PII phone digit limits require maxDigits >= minDigits >= 3.');
    }
    const pattern = /\+?(?:\(\d{1,4}\)|\d{1,4})[\d(). -]{3,}\d/g;
    for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const previous = text[start - 1];
        const next = text[end];
        if (isWordCharacter(previous) || isWordCharacter(next)) {
            continue;
        }
        const digits = digitsOnly(match[0]);
        if (digits.length < minDigits || digits.length > maxDigits) {
            continue;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(match[0])) {
            continue;
        }
        addRange(ranges, { end, kind: 'phone', start });
    }
}
function addRange(ranges, candidate) {
    const overlaps = ranges.some((range) => candidate.start < range.end && candidate.end > range.start);
    if (!overlaps) {
        ranges.push(candidate);
    }
}
function passesLuhn(digits) {
    if (/^(\d)\1+$/.test(digits)) {
        return false;
    }
    let sum = 0;
    let shouldDouble = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
        let digit = Number(digits[index]);
        if (shouldDouble) {
            digit *= 2;
            if (digit > 9) {
                digit -= 9;
            }
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
}
function digitsOnly(value) {
    return value.replaceAll(/\D/g, '');
}
function isDigit(value) {
    return value !== undefined && /\d/.test(value);
}
function isWordCharacter(value) {
    return value !== undefined && /[A-Za-z0-9_]/.test(value);
}
function summarize(occurrences) {
    const byKind = {
        credit_card: 0,
        email: 0,
        phone: 0,
    };
    for (const occurrence of occurrences) {
        byKind[occurrence.kind] += 1;
    }
    return {
        byKind,
        occurrences,
        total: occurrences.length,
    };
}
