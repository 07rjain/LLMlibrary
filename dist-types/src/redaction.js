const REDACTED = '[REDACTED]';
export function sanitizeForLogging(value) {
    return sanitizeValue(value);
}
function sanitizeValue(value) {
    if (value instanceof Error) {
        return {
            message: sanitizeString(value.message),
            name: value.name,
            ...(value.stack ? { stack: sanitizeString(value.stack) } : {}),
        };
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item));
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
            key,
            isSensitiveKey(key) ? REDACTED : sanitizeValue(entryValue),
        ]));
    }
    if (typeof value === 'string') {
        return sanitizeString(value);
    }
    return value;
}
function isSensitiveKey(key) {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
    return (normalized === 'apikey' ||
        normalized === 'authorization' ||
        normalized === 'connectionstring' ||
        normalized === 'cookie' ||
        normalized === 'databaseurl' ||
        normalized === 'dsn' ||
        normalized === 'password' ||
        normalized === 'secret' ||
        normalized === 'token' ||
        normalized === 'accesstoken' ||
        normalized === 'refreshtoken' ||
        normalized === 'idtoken' ||
        normalized === 'xapikey');
}
function sanitizeString(value) {
    return value
        .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, (_, prefix) => `${prefix}${REDACTED}`)
        .replace(/(postgres(?:ql)?:\/\/)([^/\s:@]+)(?::[^@\s/]+)?@/gi, (_, prefix) => `${prefix}${REDACTED}@`)
        .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED);
}
