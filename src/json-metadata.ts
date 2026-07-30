import { cloneJson, inspectRecord } from './validation-helpers.js';

import type { ValidationContext } from './validation-helpers.js';
import type { JsonValue } from './types.js';

/** Validates and snapshots request metadata without invoking accessors. */
export function validateAndCloneMetadata(
  metadata: unknown,
  option = 'metadata',
  maxDepth = 32,
): Record<string, JsonValue> {
  const context: ValidationContext = {
    code: 'invalid_metadata',
    message: 'metadata must contain only JSON-safe values.',
    option,
  };
  inspectRecord(metadata, context, option);
  return cloneJson(
    metadata,
    context,
    option,
    new Set(),
    Math.max(0, 32 - maxDepth),
  ) as Record<string, JsonValue>;
}
