import { ProviderCapabilityError } from 'unified-llm-client/errors';

import type { JsonValue } from './types.js';

const DEFAULT_MAX_DEPTH = 32;
const MAX_ERROR_PATH_LENGTH = 256;

/**
 * Validates and snapshots request metadata without invoking accessors.
 * The returned graph contains only JSON values and is isolated from callers.
 */
export function validateAndCloneMetadata(
  metadata: unknown,
  option: string = 'metadata',
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Record<string, JsonValue> {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throwMetadataError(option, 'plain_object');
  }
  return cloneJsonValue(metadata, option, 0, maxDepth, new Set()) as Record<
    string,
    JsonValue
  >;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  ancestors: Set<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throwMetadataError(path, 'finite_number');
    }
    return value;
  }

  if (typeof value !== 'object') {
    throwMetadataError(path, 'json_value');
  }
  if (depth >= maxDepth) {
    throwMetadataError(path, 'maximum_depth');
  }
  if (ancestors.has(value)) {
    throwMetadataError(path, 'acyclic');
  }

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    throwMetadataError(path, 'plain_object');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throwMetadataError(path, 'string_keys');
  }

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if ('get' in descriptor || 'set' in descriptor) {
        throwMetadataError(
          Array.isArray(value) && key !== 'length'
            ? `${path}[${key}]`
            : `${path}.${key}`,
          'data_property',
        );
      }
    }

    if (isArray) {
      for (const key of Object.keys(descriptors)) {
        if (key === 'length') {
          continue;
        }
        if (!/^(0|[1-9]\d*)$/.test(key)) {
          throwMetadataError(`${path}.${key}`, 'array_index');
        }
        if (!descriptors[key]?.enumerable) {
          throwMetadataError(`${path}[${key}]`, 'enumerable_property');
        }
      }
      const clone: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
          throwMetadataError(`${path}[${index}]`, 'dense_array');
        }
        clone.push(
          cloneJsonValue(
            descriptor.value,
            `${path}[${index}]`,
            depth + 1,
            maxDepth,
            ancestors,
          ),
        );
      }
      return clone;
    }

    const clone: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) {
        throwMetadataError(`${path}.${key}`, 'enumerable_property');
      }
      clone[key] = cloneJsonValue(
        descriptor.value,
        `${path}.${key}`,
        depth + 1,
        maxDepth,
        ancestors,
      );
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function throwMetadataError(path: string, constraint: string): never {
  throw new ProviderCapabilityError(
    'metadata must contain only JSON-safe values.',
    {
      details: {
        code: 'invalid_metadata',
        constraint,
        option: 'metadata',
        path: sanitiseErrorPath(path),
      },
      statusCode: 400,
    },
  );
}

function sanitiseErrorPath(path: string): string {
  const sanitised = path.replace(/\p{C}/gu, '?');
  const characters = [...sanitised];
  if (characters.length <= MAX_ERROR_PATH_LENGTH) {
    return sanitised;
  }
  return `${characters.slice(0, MAX_ERROR_PATH_LENGTH - 3).join('')}...`;
}
