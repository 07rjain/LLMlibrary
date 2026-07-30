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
import type {
  CanonicalTool,
  CanonicalToolSchema,
  JsonObject,
} from './types.js';

const FIELDS = ['cacheControl', 'description', 'execute', 'name', 'parameters'];

export function validateAndCloneTools(
  value: unknown,
  provider?: ValidationContext['provider'],
  model?: string,
): CanonicalTool[] {
  const context = toolContext(provider, model);
  const seen = new Map<string, number>();
  return inspectArray(value, context, 'tools').map((item, index) => {
    const tool = cloneTool(item.value, context, `tools[${index}]`);
    const firstIndex = seen.get(tool.name);
    if (firstIndex !== undefined) {
      invalid(context, 'unique_name', {
        duplicateIndex: index,
        firstIndex,
        path: `tools[${index}].name`,
      });
    }
    seen.set(tool.name, index);
    return tool;
  });
}

export function validateAndCloneTool(
  value: unknown,
  provider?: ValidationContext['provider'],
  model?: string,
): CanonicalTool {
  return cloneTool(value, toolContext(provider, model), 'tool');
}

function cloneTool(
  value: unknown,
  context: ValidationContext,
  path: string,
): CanonicalTool {
  const d = inspectRecord(value, context, path, FIELDS);
  const name = readValue(d, 'name');
  const description = readValue(d, 'description');
  const execute = readValue(d, 'execute');
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    invalid(context, 'portable_tool_name', { path: `${path}.name` });
  }
  if (typeof description !== 'string' || !description.trim()) {
    invalid(context, 'non_empty_string', { path: `${path}.description` });
  }
  if (
    hasValue(d, 'execute') &&
    execute !== undefined &&
    typeof execute !== 'function'
  ) {
    invalid(context, 'function_or_undefined', { path: `${path}.execute` });
  }
  const parameters = cloneJson(
    readValue(d, 'parameters'),
    context,
    `${path}.parameters`,
  ) as JsonObject;
  if (parameters?.type !== 'object' || Array.isArray(parameters)) {
    invalid(context, 'root_object_schema', { path: `${path}.parameters` });
  }
  const cacheControl = hasValue(d, 'cacheControl')
    ? validateCacheControl(
        readValue(d, 'cacheControl'),
        { ...context, code: 'invalid_cache_control', option: 'cacheControl' },
        `${path}.cacheControl`,
      )
    : undefined;
  return {
    ...(cacheControl ? { cacheControl } : {}),
    description,
    ...(typeof execute === 'function'
      ? { execute: execute as NonNullable<CanonicalTool['execute']> }
      : {}),
    name,
    parameters: parameters as unknown as CanonicalToolSchema,
  };
}

function toolContext(
  provider?: ValidationContext['provider'],
  model?: string,
): ValidationContext {
  return {
    code: 'invalid_tool',
    message: 'Invalid tool definition.',
    option: 'tools',
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}
