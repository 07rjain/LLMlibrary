import { validateCacheControl } from './cache-validation.js';
import {
  cloneJson,
  hasValue,
  inspectArray,
  inspectRecord,
  invalid,
  readValue,
} from './validation-helpers.js';

import type { ValidationContext } from './validation-helpers.js';
import type { CanonicalMessage, CanonicalPart, JsonObject } from './types.js';

const MESSAGE_FIELDS = ['content', 'metadata', 'pinned', 'role'] as const;
const PART_FIELDS: Record<string, readonly string[]> = {
  audio: ['data', 'mediaType', 'type', 'url'],
  document: ['cacheControl', 'data', 'mediaType', 'title', 'type', 'url'],
  image_base64: ['cacheControl', 'data', 'mediaType', 'type'],
  image_url: ['cacheControl', 'mediaType', 'type', 'url'],
  text: ['cacheControl', 'text', 'type'],
  tool_call: ['args', 'cacheControl', 'id', 'name', 'type'],
  tool_result: [
    'cacheControl',
    'isError',
    'name',
    'result',
    'toolCallId',
    'type',
  ],
};

export function validateAndCloneCanonicalMessages(
  value: unknown,
  context: ValidationContext = {
    code: 'invalid_context_manager_output',
    message: 'Context manager returned invalid canonical messages.',
    option: 'contextManager.trim',
  },
  path = 'messages',
): CanonicalMessage[] {
  return inspectArray(value, context, path).map((descriptor, index) =>
    cloneMessage(descriptor.value, context, `${path}[${index}]`),
  );
}

function cloneMessage(
  value: unknown,
  context: ValidationContext,
  path: string,
): CanonicalMessage {
  const descriptors = inspectRecord(value, context, path, MESSAGE_FIELDS);
  const role = readValue(descriptors, 'role');
  const content = readValue(descriptors, 'content');
  const pinned = readValue(descriptors, 'pinned');
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    invalid(context, 'canonical_role', { path: `${path}.role` });
  }
  if (
    hasValue(descriptors, 'pinned') &&
    pinned !== undefined &&
    typeof pinned !== 'boolean'
  ) {
    invalid(context, 'boolean', { path: `${path}.pinned` });
  }

  const clonedContent =
    typeof content === 'string'
      ? content
      : inspectArray(content, context, `${path}.content`).map(
          (descriptor, index) =>
            clonePart(descriptor.value, context, `${path}.content[${index}]`),
        );
  const metadata =
    hasValue(descriptors, 'metadata') &&
    readValue(descriptors, 'metadata') !== undefined
      ? cloneJson(
          readValue(descriptors, 'metadata'),
          context,
          `${path}.metadata`,
        )
      : undefined;
  if (
    metadata !== undefined &&
    (typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata))
  ) {
    invalid(context, 'plain_object', { path: `${path}.metadata` });
  }

  return {
    content: clonedContent,
    ...(metadata !== undefined
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
    ...(typeof pinned === 'boolean' ? { pinned } : {}),
    role,
  };
}

function clonePart(
  value: unknown,
  context: ValidationContext,
  path: string,
): CanonicalPart {
  const initial = inspectRecord(value, context, path);
  const type = readValue(initial, 'type');
  if (typeof type !== 'string' || !(type in PART_FIELDS)) {
    return invalid(context, 'canonical_part_type', { path: `${path}.type` });
  }
  const descriptors = inspectRecord(value, context, path, PART_FIELDS[type]);
  const string = (key: string, optional = false): string | undefined => {
    const field = readValue(descriptors, key);
    if (optional && (!hasValue(descriptors, key) || field === undefined)) {
      return undefined;
    }
    if (typeof field !== 'string') {
      return invalid(context, 'string', { path: `${path}.${key}` });
    }
    return field;
  };
  const identifier = (key: string, optional = false): string | undefined => {
    const field = string(key, optional);
    if (field !== undefined && field.length === 0) {
      return invalid(context, 'non_empty_string', {
        path: `${path}.${key}`,
      });
    }
    return field;
  };
  const cacheControl =
    hasValue(descriptors, 'cacheControl') &&
    readValue(descriptors, 'cacheControl') !== undefined
      ? validateCacheControl(
          readValue(descriptors, 'cacheControl'),
          {
            ...context,
            code: 'invalid_cache_control',
            message: 'Invalid Anthropic cache control.',
            option: 'cacheControl',
          },
          `${path}.cacheControl`,
        )
      : undefined;

  switch (type) {
    case 'text':
      return {
        ...(cacheControl ? { cacheControl } : {}),
        text: string('text')!,
        type,
      };
    case 'image_url':
      return {
        ...(cacheControl ? { cacheControl } : {}),
        ...(string('mediaType', true) !== undefined
          ? { mediaType: string('mediaType', true)! }
          : {}),
        type,
        url: string('url')!,
      };
    case 'image_base64':
      return {
        ...(cacheControl ? { cacheControl } : {}),
        data: string('data')!,
        mediaType: string('mediaType')!,
        type,
      };
    case 'document': {
      const data = string('data', true);
      const url = string('url', true);
      if (data === undefined && url === undefined) {
        invalid(context, 'data_or_url', { path });
      }
      return {
        ...(cacheControl ? { cacheControl } : {}),
        ...(data !== undefined ? { data } : {}),
        mediaType: string('mediaType')!,
        ...(string('title', true) !== undefined
          ? { title: string('title', true)! }
          : {}),
        type,
        ...(url !== undefined ? { url } : {}),
      };
    }
    case 'audio': {
      const data = string('data', true);
      const url = string('url', true);
      if (data === undefined && url === undefined) {
        invalid(context, 'data_or_url', { path });
      }
      return {
        ...(data !== undefined ? { data } : {}),
        mediaType: string('mediaType')!,
        type,
        ...(url !== undefined ? { url } : {}),
      };
    }
    case 'tool_call': {
      const args = cloneJson(
        readValue(descriptors, 'args'),
        context,
        `${path}.args`,
      );
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        invalid(context, 'plain_object', { path: `${path}.args` });
      }
      return {
        args: args as JsonObject,
        ...(cacheControl ? { cacheControl } : {}),
        id: identifier('id')!,
        name: identifier('name')!,
        type,
      };
    }
    case 'tool_result': {
      const isError = readValue(descriptors, 'isError');
      if (
        hasValue(descriptors, 'isError') &&
        isError !== undefined &&
        typeof isError !== 'boolean'
      ) {
        invalid(context, 'boolean', { path: `${path}.isError` });
      }
      return {
        ...(cacheControl ? { cacheControl } : {}),
        ...(typeof isError === 'boolean' ? { isError } : {}),
        ...(identifier('name', true) !== undefined
          ? { name: identifier('name', true)! }
          : {}),
        result: cloneJson(
          readValue(descriptors, 'result'),
          context,
          `${path}.result`,
        ),
        toolCallId: identifier('toolCallId')!,
        type,
      };
    }
  }
  return invalid(context, 'canonical_part_type', { path: `${path}.type` });
}
