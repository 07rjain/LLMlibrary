import { InvalidConversationSnapshotError } from 'unified-llm-client/errors';
import { validateAndCloneCanonicalMessages } from './message-validation.js';
import { validateAndCloneTools } from './tool-validation.js';
import {
  cloneJsonOmittingUndefinedProperties,
  hasValue,
  inspectRecord,
  invalid,
  readValue,
} from './validation-helpers.js';

import type { ConversationSnapshot } from './conversation.js';
import type {
  CanonicalProvider,
  CanonicalToolChoice,
  JsonObject,
  ProviderOptions,
  ResponseFormat,
} from './types.js';
import type { ValidationContext } from './validation-helpers.js';

const PROVIDERS = new Set<CanonicalProvider>([
  'anthropic',
  'azure-openai',
  'bedrock',
  'cohere',
  'google',
  'groq',
  'mistral',
  'mock',
  'ollama',
  'openai',
]);
const MAX_TOOL_ROUNDS = 100;
const MAX_TOOL_EXECUTION_TIMEOUT_MS = 300_000;
const CONTROL_CHARACTER = /\p{C}/u;

const SNAPSHOT_CONTEXT: ValidationContext = {
  code: 'invalid_conversation_snapshot',
  createError(constraint, details): never {
    throw new InvalidConversationSnapshotError(
      typeof details.path === 'string' ? details.path : 'snapshot',
      constraint,
    );
  },
  message: 'Conversation snapshot is invalid.',
  option: 'snapshot',
};

/**
 * Validates an untrusted persisted snapshot before hydration and returns only
 * the recognized, deeply cloned conversation fields.
 */
export function validateAndCloneConversationSnapshot(
  value: unknown,
): ConversationSnapshot {
  try {
    return validateSnapshot(value);
  } catch (error) {
    if (error instanceof InvalidConversationSnapshotError) {
      throw error;
    }
    throw new InvalidConversationSnapshotError('snapshot', 'inspectable_data');
  }
}

function validateSnapshot(value: unknown): ConversationSnapshot {
  const fields = inspectRecord(value, SNAPSHOT_CONTEXT, 'snapshot');
  const createdAt = date(fields, 'createdAt');
  const updatedAt = date(fields, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    invalid(SNAPSHOT_CONTEXT, 'not_before_created_at', {
      path: 'snapshot.updatedAt',
    });
  }

  const sessionId = requiredString(fields, 'sessionId');
  if (sessionId.length === 0 || CONTROL_CHARACTER.test(sessionId)) {
    invalid(SNAPSHOT_CONTEXT, 'non_empty_string_without_control_characters', {
      path: 'snapshot.sessionId',
    });
  }

  const provider = optionalProvider(fields, 'provider');
  const model = optionalString(fields, 'model');
  const messages = validateAndCloneCanonicalMessages(
    readValue(fields, 'messages'),
    SNAPSHOT_CONTEXT,
    'snapshot.messages',
  );
  const totalCachedTokens = requiredTokenTotal(fields, 'totalCachedTokens');
  const totalCostUSD = requiredFiniteNonNegative(fields, 'totalCostUSD', false);
  const totalInputTokens = requiredTokenTotal(fields, 'totalInputTokens');
  const totalOutputTokens = requiredTokenTotal(fields, 'totalOutputTokens');
  const totalReasoningTokens = hasDefinedValue(fields, 'totalReasoningTokens')
    ? requiredTokenTotal(fields, 'totalReasoningTokens')
    : 0;
  const version = hasDefinedValue(fields, 'version')
    ? requiredTokenTotal(fields, 'version')
    : 0;

  const budgetUsd = optionalFiniteNonNegative(fields, 'budgetUsd', false);
  const maxContextTokens = optionalFiniteNonNegative(
    fields,
    'maxContextTokens',
    true,
  );
  const maxTokens = optionalFiniteNonNegative(fields, 'maxTokens', true);
  const maxToolRounds = optionalBoundedNumber(
    fields,
    'maxToolRounds',
    0,
    MAX_TOOL_ROUNDS,
    true,
  );
  const toolExecutionTimeoutMs = optionalBoundedNumber(
    fields,
    'toolExecutionTimeoutMs',
    1,
    MAX_TOOL_EXECUTION_TIMEOUT_MS,
    false,
  );
  const providerOptions = optionalProviderOptions(fields);
  const responseFormat = optionalResponseFormat(fields);
  const toolChoice = optionalToolChoice(fields);
  const tools = hasDefinedValue(fields, 'tools')
    ? validateAndCloneTools(
        cloneJsonOmittingUndefinedProperties(
          readValue(fields, 'tools'),
          SNAPSHOT_CONTEXT,
          'snapshot.tools',
        ),
        provider,
        model,
        SNAPSHOT_CONTEXT,
      )
    : undefined;
  const toolValidation = optionalEnum(
    fields,
    'toolValidation',
    new Set(['permissive', 'strict'] as const),
  );

  return {
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    createdAt,
    ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    messages,
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    ...(responseFormat !== undefined ? { responseFormat } : {}),
    sessionId,
    ...(optionalString(fields, 'system') !== undefined
      ? { system: optionalString(fields, 'system')! }
      : {}),
    ...(optionalString(fields, 'tenantId') !== undefined
      ? { tenantId: optionalString(fields, 'tenantId')! }
      : {}),
    ...(toolExecutionTimeoutMs !== undefined ? { toolExecutionTimeoutMs } : {}),
    ...(toolValidation !== undefined ? { toolValidation } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(tools !== undefined ? { tools } : {}),
    totalCachedTokens,
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    updatedAt,
    version,
  };
}

function date(fields: Record<string, PropertyDescriptor>, key: string): string {
  const value = requiredString(fields, key);
  if (!Number.isFinite(Date.parse(value))) {
    invalid(SNAPSHOT_CONTEXT, 'parseable_date', {
      path: `snapshot.${key}`,
    });
  }
  return value;
}

function requiredString(
  fields: Record<string, PropertyDescriptor>,
  key: string,
): string {
  const value = readValue(fields, key);
  if (!hasValue(fields, key)) {
    invalid(SNAPSHOT_CONTEXT, 'required', { path: `snapshot.${key}` });
  }
  if (typeof value !== 'string') {
    invalid(SNAPSHOT_CONTEXT, 'string', { path: `snapshot.${key}` });
  }
  return value;
}

function optionalString(
  fields: Record<string, PropertyDescriptor>,
  key: string,
): string | undefined {
  if (!hasDefinedValue(fields, key)) {
    return undefined;
  }
  const value = readValue(fields, key);
  if (typeof value !== 'string') {
    invalid(SNAPSHOT_CONTEXT, 'string', { path: `snapshot.${key}` });
  }
  return value;
}

function optionalProvider(
  fields: Record<string, PropertyDescriptor>,
  key: string,
): CanonicalProvider | undefined {
  const value = optionalString(fields, key);
  if (value !== undefined && !PROVIDERS.has(value as CanonicalProvider)) {
    invalid(SNAPSHOT_CONTEXT, 'canonical_provider', {
      path: `snapshot.${key}`,
    });
  }
  return value as CanonicalProvider | undefined;
}

function requiredTokenTotal(
  fields: Record<string, PropertyDescriptor>,
  key: string,
): number {
  return requiredFiniteNonNegative(fields, key, true);
}

function requiredFiniteNonNegative(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  integer: boolean,
): number {
  if (!hasValue(fields, key)) {
    invalid(SNAPSHOT_CONTEXT, 'required', { path: `snapshot.${key}` });
  }
  const value = readValue(fields, key);
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    invalid(
      SNAPSHOT_CONTEXT,
      integer
        ? 'finite_non_negative_safe_integer'
        : 'finite_non_negative_number',
      { path: `snapshot.${key}` },
    );
  }
  return value;
}

function optionalFiniteNonNegative(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  integer: boolean,
): number | undefined {
  return hasDefinedValue(fields, key)
    ? requiredFiniteNonNegative(fields, key, integer)
    : undefined;
}

function optionalBoundedNumber(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  minimum: number,
  maximum: number,
  integer: boolean,
): number | undefined {
  if (!hasDefinedValue(fields, key)) {
    return undefined;
  }
  const value = readValue(fields, key);
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    invalid(
      SNAPSHOT_CONTEXT,
      integer
        ? `safe_integer_between_${minimum}_and_${maximum}`
        : `finite_number_between_${minimum}_and_${maximum}`,
      { path: `snapshot.${key}` },
    );
  }
  return value;
}

function optionalJsonObject<TValue>(
  fields: Record<string, PropertyDescriptor>,
  key: string,
): TValue | undefined {
  if (!hasDefinedValue(fields, key)) {
    return undefined;
  }
  const cloned = cloneJsonOmittingUndefinedProperties(
    readValue(fields, key),
    SNAPSHOT_CONTEXT,
    `snapshot.${key}`,
  );
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
    invalid(SNAPSHOT_CONTEXT, 'plain_object', {
      path: `snapshot.${key}`,
    });
  }
  return cloned as TValue;
}

function optionalResponseFormat(
  fields: Record<string, PropertyDescriptor>,
): ResponseFormat | undefined {
  const value = optionalJsonObject<JsonObject>(fields, 'responseFormat');
  if (value === undefined) {
    return undefined;
  }
  const descriptors = inspectRecord(
    value,
    SNAPSHOT_CONTEXT,
    'snapshot.responseFormat',
    ['name', 'parse', 'schema', 'strict', 'type'],
  );
  const type = readValue(descriptors, 'type');
  if (type !== 'json_object' && type !== 'json_schema' && type !== 'text') {
    invalid(SNAPSHOT_CONTEXT, 'response_format_type', {
      path: 'snapshot.responseFormat.type',
    });
  }
  for (const booleanKey of ['parse', 'strict']) {
    if (
      hasValue(descriptors, booleanKey) &&
      typeof readValue(descriptors, booleanKey) !== 'boolean'
    ) {
      invalid(SNAPSHOT_CONTEXT, 'boolean', {
        path: `snapshot.responseFormat.${booleanKey}`,
      });
    }
  }
  if (
    hasValue(descriptors, 'name') &&
    typeof readValue(descriptors, 'name') !== 'string'
  ) {
    invalid(SNAPSHOT_CONTEXT, 'string', {
      path: 'snapshot.responseFormat.name',
    });
  }
  if (type === 'json_schema') {
    const schema = readValue(descriptors, 'schema');
    if (
      typeof schema !== 'object' ||
      schema === null ||
      Array.isArray(schema)
    ) {
      invalid(SNAPSHOT_CONTEXT, 'plain_object', {
        path: 'snapshot.responseFormat.schema',
      });
    }
  } else if (
    hasValue(descriptors, 'schema') ||
    hasValue(descriptors, 'name') ||
    hasValue(descriptors, 'strict')
  ) {
    invalid(SNAPSHOT_CONTEXT, 'fields_allowed_for_type', {
      path: 'snapshot.responseFormat',
    });
  }
  return value as unknown as ResponseFormat;
}

function optionalProviderOptions(
  fields: Record<string, PropertyDescriptor>,
): ProviderOptions | undefined {
  const value = optionalJsonObject<JsonObject>(fields, 'providerOptions');
  if (value === undefined) {
    return undefined;
  }
  const providers = inspectRecord(
    value,
    SNAPSHOT_CONTEXT,
    'snapshot.providerOptions',
    ['anthropic', 'google', 'openai'],
  );
  if (hasValue(providers, 'anthropic')) {
    const anthropic = nestedOptions(providers, 'anthropic', [
      'cacheControl',
      'effort',
      'thinking',
    ]);
    enumField(
      anthropic,
      'effort',
      new Set(['high', 'low', 'max', 'medium', 'xhigh']),
      'snapshot.providerOptions.anthropic',
    );
    cacheControlField(anthropic, 'snapshot.providerOptions.anthropic');
    if (hasValue(anthropic, 'thinking')) {
      const thinking = nestedRecord(
        readValue(anthropic, 'thinking'),
        'snapshot.providerOptions.anthropic.thinking',
        ['budgetTokens', 'display', 'type'],
      );
      enumField(
        thinking,
        'type',
        new Set(['adaptive', 'disabled', 'enabled']),
        'snapshot.providerOptions.anthropic.thinking',
        true,
      );
      enumField(
        thinking,
        'display',
        new Set(['omitted', 'summarized']),
        'snapshot.providerOptions.anthropic.thinking',
      );
      numericField(
        thinking,
        'budgetTokens',
        'snapshot.providerOptions.anthropic.thinking',
        0,
      );
    }
  }
  if (hasValue(providers, 'google')) {
    const google = nestedOptions(providers, 'google', [
      'promptCaching',
      'thinking',
    ]);
    if (hasValue(google, 'promptCaching')) {
      const caching = nestedRecord(
        readValue(google, 'promptCaching'),
        'snapshot.providerOptions.google.promptCaching',
        ['cachedContent'],
      );
      stringField(
        caching,
        'cachedContent',
        'snapshot.providerOptions.google.promptCaching',
      );
    }
    if (hasValue(google, 'thinking')) {
      const thinking = nestedRecord(
        readValue(google, 'thinking'),
        'snapshot.providerOptions.google.thinking',
        ['budgetTokens', 'includeThoughts', 'level'],
      );
      numericField(
        thinking,
        'budgetTokens',
        'snapshot.providerOptions.google.thinking',
        // Gemini documents -1 as dynamic thinking and 0 as disabled thinking.
        -1,
      );
      booleanField(
        thinking,
        'includeThoughts',
        'snapshot.providerOptions.google.thinking',
      );
      enumField(
        thinking,
        'level',
        new Set(['high', 'low', 'medium', 'minimal']),
        'snapshot.providerOptions.google.thinking',
      );
    }
  }
  if (hasValue(providers, 'openai')) {
    const openai = nestedOptions(providers, 'openai', [
      'promptCaching',
      'reasoning',
    ]);
    if (hasValue(openai, 'promptCaching')) {
      const caching = nestedRecord(
        readValue(openai, 'promptCaching'),
        'snapshot.providerOptions.openai.promptCaching',
        ['key', 'retention'],
      );
      stringField(
        caching,
        'key',
        'snapshot.providerOptions.openai.promptCaching',
      );
      enumField(
        caching,
        'retention',
        new Set(['24h', 'in_memory']),
        'snapshot.providerOptions.openai.promptCaching',
      );
    }
    if (hasValue(openai, 'reasoning')) {
      const reasoning = nestedRecord(
        readValue(openai, 'reasoning'),
        'snapshot.providerOptions.openai.reasoning',
        ['effort', 'includeEncryptedContent', 'summary'],
      );
      enumField(
        reasoning,
        'effort',
        new Set(['high', 'low', 'medium', 'minimal', 'none', 'xhigh']),
        'snapshot.providerOptions.openai.reasoning',
      );
      booleanField(
        reasoning,
        'includeEncryptedContent',
        'snapshot.providerOptions.openai.reasoning',
      );
      enumField(
        reasoning,
        'summary',
        new Set(['auto', 'concise', 'detailed']),
        'snapshot.providerOptions.openai.reasoning',
      );
    }
  }
  return value as unknown as ProviderOptions;
}

function nestedOptions(
  providers: Record<string, PropertyDescriptor>,
  provider: string,
  allowed: readonly string[],
): Record<string, PropertyDescriptor> {
  return nestedRecord(
    readValue(providers, provider),
    `snapshot.providerOptions.${provider}`,
    allowed,
  );
}

function nestedRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, PropertyDescriptor> {
  return inspectRecord(value, SNAPSHOT_CONTEXT, path, allowed);
}

function stringField(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  path: string,
): void {
  if (hasValue(fields, key) && typeof readValue(fields, key) !== 'string') {
    invalid(SNAPSHOT_CONTEXT, 'string', { path: `${path}.${key}` });
  }
}

function booleanField(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  path: string,
): void {
  if (hasValue(fields, key) && typeof readValue(fields, key) !== 'boolean') {
    invalid(SNAPSHOT_CONTEXT, 'boolean', { path: `${path}.${key}` });
  }
}

function numericField(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  path: string,
  minimum = 0,
): void {
  if (!hasDefinedValue(fields, key)) {
    return;
  }
  const value = readValue(fields, key);
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    invalid(SNAPSHOT_CONTEXT, 'finite_safe_integer', {
      path: `${path}.${key}`,
    });
  }
}

function enumField<TValue extends string>(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  values: ReadonlySet<TValue>,
  path: string,
  required = false,
): void {
  if (!hasDefinedValue(fields, key)) {
    if (required) {
      invalid(SNAPSHOT_CONTEXT, 'required', { path: `${path}.${key}` });
    }
    return;
  }
  const value = readValue(fields, key);
  if (typeof value !== 'string' || !values.has(value as TValue)) {
    invalid(SNAPSHOT_CONTEXT, 'allowed_value', {
      path: `${path}.${key}`,
    });
  }
}

function cacheControlField(
  fields: Record<string, PropertyDescriptor>,
  path: string,
): void {
  if (!hasValue(fields, 'cacheControl')) {
    return;
  }
  const cacheControl = nestedRecord(
    readValue(fields, 'cacheControl'),
    `${path}.cacheControl`,
    ['ttl', 'type'],
  );
  enumField(
    cacheControl,
    'type',
    new Set(['ephemeral']),
    `${path}.cacheControl`,
    true,
  );
  enumField(cacheControl, 'ttl', new Set(['1h', '5m']), `${path}.cacheControl`);
}

function optionalToolChoice(
  fields: Record<string, PropertyDescriptor>,
): CanonicalToolChoice | undefined {
  const value = optionalJsonObject<JsonObject>(fields, 'toolChoice');
  if (value === undefined) {
    return undefined;
  }
  const descriptors = inspectRecord(
    value,
    SNAPSHOT_CONTEXT,
    'snapshot.toolChoice',
    ['disableParallelToolUse', 'name', 'type'],
  );
  const type = readValue(descriptors, 'type');
  if (type === 'tool') {
    const name = readValue(descriptors, 'name');
    if (typeof name !== 'string' || name.length === 0) {
      invalid(SNAPSHOT_CONTEXT, 'non_empty_string', {
        path: 'snapshot.toolChoice.name',
      });
    }
    if (
      hasValue(descriptors, 'disableParallelToolUse') &&
      typeof readValue(descriptors, 'disableParallelToolUse') !== 'boolean'
    ) {
      invalid(SNAPSHOT_CONTEXT, 'boolean', {
        path: 'snapshot.toolChoice.disableParallelToolUse',
      });
    }
  } else if (type !== 'any' && type !== 'auto' && type !== 'none') {
    invalid(SNAPSHOT_CONTEXT, 'tool_choice_type', {
      path: 'snapshot.toolChoice.type',
    });
  } else if (
    hasValue(descriptors, 'name') ||
    hasValue(descriptors, 'disableParallelToolUse')
  ) {
    invalid(SNAPSHOT_CONTEXT, 'fields_allowed_for_type', {
      path: 'snapshot.toolChoice',
    });
  }
  return value as unknown as CanonicalToolChoice;
}

function optionalEnum<TValue extends string>(
  fields: Record<string, PropertyDescriptor>,
  key: string,
  values: ReadonlySet<TValue>,
): TValue | undefined {
  if (!hasDefinedValue(fields, key)) {
    return undefined;
  }
  const value = readValue(fields, key);
  if (typeof value !== 'string' || !values.has(value as TValue)) {
    invalid(SNAPSHOT_CONTEXT, 'allowed_value', {
      path: `snapshot.${key}`,
    });
  }
  return value as TValue;
}

function hasDefinedValue(
  fields: Record<string, PropertyDescriptor>,
  key: string,
): boolean {
  return hasValue(fields, key) && readValue(fields, key) !== undefined;
}
