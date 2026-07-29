import { ProviderError } from 'unified-llm-client/errors';

import type { RemoteModelProvider } from './types.js';

export async function readModelDiscoveryPage(
  response: Response,
  provider: RemoteModelProvider,
  recordsKey: 'data' | 'models',
): Promise<{ page: Record<string, unknown>; records: unknown[] }> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw discoveryError(provider, 'response', 'valid_json');
  }

  if (!isPlainObject(payload) || !Array.isArray(payload[recordsKey])) {
    throw discoveryError(provider, recordsKey, 'array_envelope');
  }

  return {
    page: payload,
    records: payload[recordsKey],
  };
}

export function readRequiredModelId(
  value: unknown,
  key: string,
): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const id = value[key];
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readOptionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;
}

export function readPaginationCursor(
  value: unknown,
  seen: Set<string>,
  provider: RemoteModelProvider,
  option: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw discoveryError(provider, option, 'non_empty_string');
  }
  if (seen.has(value)) {
    throw discoveryError(provider, option, 'unique_pagination_cursor');
  }
  seen.add(value);
  return value;
}

export function discoveryError(
  provider: RemoteModelProvider,
  option: string,
  constraint: string,
): ProviderError {
  return new ProviderError(`Invalid ${provider} model discovery response.`, {
    details: {
      constraint,
      option,
    },
    provider,
    retryable: false,
    statusCode: 502,
  });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
