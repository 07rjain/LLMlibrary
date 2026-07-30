import { ProviderCapabilityError } from 'unified-llm-client/errors';

import type { CanonicalProvider, JsonValue } from './types.js';

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

export interface ValidationContext {
  code: string;
  message: string;
  model?: string;
  option: string;
  provider?: CanonicalProvider;
}

export function invalid(
  context: ValidationContext,
  constraint: string,
  details: Record<string, unknown> = {},
): never {
  if (typeof details.path === 'string') {
    const path = details.path.replace(/\p{C}/gu, '?');
    details.path = path.length > 256 ? `${path.slice(0, 253)}...` : path;
  }
  throw new ProviderCapabilityError(context.message, {
    details: {
      code: context.code,
      constraint,
      option: context.option,
      ...details,
    },
    ...(context.model ? { model: context.model } : {}),
    ...(context.provider ? { provider: context.provider } : {}),
    statusCode: 400,
  });
}

export function inspectRecord(
  value: unknown,
  context: ValidationContext,
  path: string,
  allowed?: readonly string[],
): Record<string, PropertyDescriptor> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  ) {
    return invalid(context, 'plain_object', { path });
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      BLOCKED.has(key) ||
      (allowed && !allowed.includes(key)) ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      return invalid(context, 'safe_data_property', { path: `${path}.${key}` });
    }
  }
  return descriptors;
}

export function inspectArray(
  value: unknown,
  context: ValidationContext,
  path: string,
): PropertyDescriptor[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length
  ) {
    return invalid(context, 'dense_array', { path });
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const items: PropertyDescriptor[] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      key !== 'length' &&
      (!/^(0|[1-9]\d*)$/.test(key) ||
        !descriptor.enumerable ||
        !('value' in descriptor))
    ) {
      return invalid(context, 'dense_array', { path: `${path}[${key}]` });
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !('value' in descriptor)) {
      return invalid(context, 'dense_array', { path: `${path}[${index}]` });
    }
    items.push(descriptor);
  }
  return items;
}

export const readValue = (
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): unknown => descriptors[key]?.value;

export const hasValue = (
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): boolean => key in descriptors;

export function cloneJson(
  value: unknown,
  context: ValidationContext,
  path: string,
  ancestors = new Set<object>(),
  depth = 0,
): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : invalid(context, 'finite_number', { path });
  }
  if (typeof value !== 'object') {
    return invalid(context, 'json_value', { path });
  }
  if (depth >= 32) {
    return invalid(context, 'maximum_depth', { path });
  }
  if (ancestors.has(value)) {
    return invalid(context, 'acyclic', { path });
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return inspectArray(value, context, path).map((item, index) =>
        cloneJson(
          item.value,
          context,
          `${path}[${index}]`,
          ancestors,
          depth + 1,
        ),
      );
    }
    return Object.fromEntries(
      Object.entries(inspectRecord(value, context, path)).map(
        ([key, descriptor]) => [
          key,
          cloneJson(
            descriptor.value,
            context,
            `${path}.${key}`,
            ancestors,
            depth + 1,
          ),
        ],
      ),
    );
  } finally {
    ancestors.delete(value);
  }
}
