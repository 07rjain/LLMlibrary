export interface RetryOptions {
  baseMs?: number;
  jitterMs?: number;
  maxAttempts?: number;
  maxMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface GeminiErrorDetail {
  '@type'?: string;
  retryDelay?: number | string | { nanos?: number; seconds?: number | string };
}

export interface GeminiErrorResponseShape {
  error?: {
    details?: GeminiErrorDetail[];
  };
}

const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403]);

export function parseRetryAfterMs(
  retryAfter: null | string,
  nowMs: number = Date.now(),
): number | null {
  if (!retryAfter) {
    return null;
  }

  const asNumber = Number(retryAfter);
  if (!Number.isNaN(asNumber)) {
    return Math.max(0, asNumber * 1000);
  }

  const parsedDate = Date.parse(retryAfter);
  if (Number.isNaN(parsedDate)) {
    return null;
  }

  return Math.max(0, parsedDate - nowMs);
}

export function parseGeminiRetryDelayMs(
  details: GeminiErrorDetail[] | undefined,
): number | null {
  if (!details) {
    return null;
  }

  for (const detail of details) {
    if (!detail.retryDelay) {
      continue;
    }

    const retryDelay = detail.retryDelay;
    if (typeof retryDelay === 'number') {
      return retryDelay * 1000;
    }

    if (typeof retryDelay === 'string') {
      const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
      if (match) {
        return Math.round(Number(match[1]) * 1000);
      }
    }

    if (typeof retryDelay === 'object') {
      const seconds = Number(retryDelay.seconds ?? 0);
      const nanos = retryDelay.nanos ?? 0;
      return Math.round(seconds * 1000 + nanos / 1_000_000);
    }
  }

  return null;
}

export async function withRetry(
  fn: (attempt: number) => Promise<Response>,
  options: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 1000;
  const maxMs = options.maxMs ?? 30000;
  const jitterMs = options.jitterMs ?? 500;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fn(attempt);
    lastResponse = response;

    if (response.ok) {
      return response;
    }

    if (NON_RETRYABLE_STATUS_CODES.has(response.status)) {
      return response;
    }

    const shouldRetry = response.status === 429 || response.status >= 500;
    if (!shouldRetry || attempt === maxAttempts) {
      return response;
    }

    let delayMs = parseRetryAfterMs(response.headers.get('retry-after'));

    if (delayMs === null && response.status === 429) {
      delayMs = parseGeminiRetryDelayMs(
        await safelyReadGeminiErrorDetails(response.clone()),
      );
    }

    if (delayMs === null) {
      delayMs = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
    }

    await sleep(delayMs + Math.floor(random() * jitterMs));
  }

  if (!lastResponse) {
    throw new Error('Retry loop exited without receiving a response.');
  }

  return lastResponse;
}

async function safelyReadGeminiErrorDetails(
  response: Response,
): Promise<GeminiErrorDetail[] | undefined> {
  try {
    const body = (await response.json()) as GeminiErrorResponseShape;
    return body.error?.details;
  } catch {
    return undefined;
  }
}
