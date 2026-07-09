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
// Exact-match keys that are too short or generic to safely match as substrings
// (e.g. "dsn" must not redact "dsnRegion"; "cookie" is a whole-key concept).
const EXACT_SENSITIVE_KEYS = new Set([
    'authorization',
    'cookie',
    'databaseurl',
    'dsn',
    'xapikey',
]);
// Sensitive tokens matched anywhere in the normalized key so that provider- or
// context-prefixed variants (openaiApiKey, gemini_api_key, dbPassword,
// serviceAccountCredentials, pgConnectionString) are also redacted.
const SENSITIVE_KEY_SUBSTRINGS = [
    'apikey',
    'secret',
    'password',
    'passwd',
    'credential',
    'connectionstring',
    'privatekey',
];
function isSensitiveKey(key) {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
    if (EXACT_SENSITIVE_KEYS.has(normalized)) {
        return true;
    }
    if (SENSITIVE_KEY_SUBSTRINGS.some((token) => normalized.includes(token))) {
        return true;
    }
    // Match the singular "...token" suffix (accessToken, refreshToken, authToken)
    // without redacting plural usage-metric fields like inputTokens / maxTokens.
    return normalized === 'token' || normalized.endsWith('token');
}
function sanitizeString(value) {
    return value
        .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, (_, prefix) => `${prefix}${REDACTED}`)
        .replace(/(postgres(?:ql)?:\/\/)([^/\s:@]+)(?::[^@\s/]+)?@/gi, (_, prefix) => `${prefix}${REDACTED}@`)
        .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED);
}
