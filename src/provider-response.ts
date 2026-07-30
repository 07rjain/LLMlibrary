import { ProviderError } from 'unified-llm-client/errors';
import { awaitWithAbort, throwIfAborted } from './stream-control.js';

import type { CanonicalProvider } from './types.js';

export interface ProviderResponseContext {
  model?: string | undefined;
  operation: string;
  provider: CanonicalProvider;
  requestId?: string | undefined;
  signal?: AbortSignal | undefined;
}

interface InvalidProviderResponseOptions {
  actualType?: string;
  contentType?: string;
  expected?: string;
  path?: string;
  phase: 'content-type' | 'json' | 'schema' | 'stream';
}

export function invalidProviderResponse(
  context: ProviderResponseContext,
  options: InvalidProviderResponseOptions,
): ProviderError {
  return new ProviderError('Provider returned an invalid successful response.', {
    details: {
      code: 'invalid_provider_response',
      operation: context.operation,
      phase: options.phase,
      reason: 'invalid_provider_response',
      ...(options.path ? { path: options.path } : {}),
      ...(options.expected ? { expected: options.expected } : {}),
      ...(options.actualType ? { actualType: options.actualType } : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
    },
    ...(context.model ? { model: context.model } : {}),
    provider: context.provider,
    ...(context.requestId ? { requestId: context.requestId } : {}),
    retryable: false,
    statusCode: 502,
  });
}

export async function readProviderJson(
  response: Response,
  context: ProviderResponseContext,
): Promise<unknown> {
  assertProviderContentType(response, context, 'json');
  throwIfAborted(context.signal);
  const text = await awaitWithAbort(response.text(), context.signal);
  throwIfAborted(context.signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidProviderResponse(context, {
      actualType: 'invalid_json',
      expected: 'valid_json',
      phase: 'json',
    });
  }
}

export function parseProviderEvent(
  payload: string,
  context: ProviderResponseContext,
): unknown {
  throwIfAborted(context.signal);
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw invalidProviderResponse(context, {
      actualType: 'invalid_json',
      expected: 'valid_json',
      phase: 'json',
    });
  }
}

export function assertProviderContentType(
  response: Response,
  context: ProviderResponseContext,
  expected: 'json' | 'sse',
): void {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const valid =
    expected === 'json'
      ? contentType.includes('application/json') ||
        contentType.includes('+json')
      : contentType.includes('text/event-stream');
  if (!valid) {
    throw invalidProviderResponse(context, {
      ...(contentType ? { contentType } : {}),
      expected:
        expected === 'json' ? 'application/json' : 'text/event-stream',
      phase: 'content-type',
    });
  }
}

export function assertProviderObject(
  value: unknown,
  context: ProviderResponseContext,
  path: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProviderResponse(context, {
      actualType: providerValueType(value),
      expected: 'object',
      path,
      phase: 'schema',
    });
  }
}

export function assertProviderArray(
  value: unknown,
  context: ProviderResponseContext,
  path: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw invalidProviderResponse(context, {
      actualType: providerValueType(value),
      expected: 'array',
      path,
      phase: 'schema',
    });
  }
}

export function assertProviderString(
  value: unknown,
  context: ProviderResponseContext,
  path: string,
): asserts value is string {
  if (typeof value !== 'string') {
    throw invalidProviderResponse(context, {
      actualType: providerValueType(value),
      expected: 'string',
      path,
      phase: 'schema',
    });
  }
}

export function assertProviderUsage(
  usage: unknown,
  fields: readonly string[],
  context: ProviderResponseContext,
  path = 'usage',
): void {
  if (usage === undefined || usage === null) {
    return;
  }
  assertProviderObject(usage, context, path);
  for (const field of fields) {
    const value = usage[field];
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0)
    ) {
      throw invalidProviderResponse(context, {
        actualType: providerValueType(value),
        expected: 'non_negative_safe_integer',
        path: `${path}.${field}`,
        phase: 'schema',
      });
    }
  }
}

function providerValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}
