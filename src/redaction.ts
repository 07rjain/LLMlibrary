const REDACTED = '[REDACTED]';

export function sanitizeForLogging<TValue>(value: TValue): TValue {
  return sanitizeValue(value) as TValue;
}

function sanitizeValue(value: unknown): unknown {
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

  if (isBinaryValue(value)) {
    return REDACTED;
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        isSensitiveKey(key) || isSensitiveContentKey(key)
          ? REDACTED
          : sanitizeValue(entryValue),
      ]),
    );
  }

  if (typeof value === 'string') {
    if (isMediaPayloadString(value)) {
      return REDACTED;
    }
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

const SENSITIVE_CONTENT_KEYS = new Set([
  'messages',
  'prompts',
  'rawbody',
  'rawrequest',
  'rawrequestbody',
  'rawresponse',
  'rawresponsebody',
  'requestbody',
  'responsebody',
  'toolargs',
  'toolargument',
  'toolarguments',
  'toolcall',
  'toolcalls',
  'toolpayload',
  'toolpayloads',
  'toolresult',
  'toolresults',
  'transcript',
  'transcripts',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
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

function isSensitiveContentKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (
    normalized === 'prompt' ||
    normalized.endsWith('prompt') ||
    SENSITIVE_CONTENT_KEYS.has(normalized)
  ) {
    return true;
  }

  // Only treat names that structurally identify media payloads as sensitive.
  // This deliberately leaves metrics such as inputAudioSeconds and generic
  // fields such as data/content untouched.
  return /^(?:input|output|request|response)?(?:audio|image|document|base64|binary|bytes)(?:base64|buffer|bytes|content|data|payload|src|uri|url)?$/.test(
    normalized,
  );
}

function normalizeKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
}

function isBinaryValue(value: unknown): boolean {
  return (
    typeof ArrayBuffer !== 'undefined' &&
    (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
  );
}

function isMediaPayloadString(value: string): boolean {
  if (/^(?:blob:|data:)/i.test(value)) {
    return true;
  }

  return isLongBase64(value);
}

function isLongBase64(value: string): boolean {
  let encodedLength = 0;
  let paddingLength = 0;
  let lastSegmentLength = 0;
  let segmentLength = 0;
  let segmentCount = 0;
  let shortSegmentCount = 0;
  let sawPadding = false;
  let sawWhitespace = false;

  const finishSegment = (): void => {
    if (segmentLength === 0) {
      return;
    }
    lastSegmentLength = segmentLength;
    segmentCount += 1;
    if (segmentLength < 16) {
      shortSegmentCount += 1;
    }
    segmentLength = 0;
  };

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 32 || (code >= 9 && code <= 13)) {
      sawWhitespace = true;
      finishSegment();
      continue;
    }

    const isAlphabet =
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (isAlphabet || isDigit || code === 43 || code === 47) {
      if (sawPadding) {
        return false;
      }
    } else if (code === 61) {
      sawPadding = true;
      paddingLength += 1;
      if (paddingLength > 2) {
        return false;
      }
    } else {
      return false;
    }

    encodedLength += 1;
    segmentLength += 1;
  }

  finishSegment();
  if (encodedLength < 256 || encodedLength % 4 !== 0) {
    return false;
  }

  // MIME/PEM-style wrapping uses substantial encoded chunks. Requiring every
  // non-final chunk to be at least 16 characters prevents ordinary multiline
  // words from becoming base64 merely because ASCII whitespace is ignored.
  if (sawWhitespace && segmentCount > 1) {
    const finalSegmentIsShort = lastSegmentLength < 16;
    if (shortSegmentCount > (finalSegmentIsShort ? 1 : 0)) {
      return false;
    }
  }

  return true;
}

function sanitizeString(value: string): string {
  return value
    .replace(
      /(Bearer\s+)[A-Za-z0-9._-]+/gi,
      (_, prefix: string) => `${prefix}${REDACTED}`,
    )
    .replace(
      /(postgres(?:ql)?:\/\/)([^/\s:@]+)(?::[^@\s/]+)?@/gi,
      (_, prefix: string) => `${prefix}${REDACTED}@`,
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED);
}
