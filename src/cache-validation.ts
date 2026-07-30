import {
  hasValue,
  inspectRecord,
  invalid,
  readValue,
} from './validation-helpers.js';

import type { ValidationContext } from './validation-helpers.js';
import type {
  CacheControl,
  CanonicalMessage,
  OpenAIPromptCachingOptions,
} from './types.js';

export function validateOpenAIPromptCaching(
  value: unknown,
  model?: string,
): OpenAIPromptCachingOptions | undefined {
  if (value === undefined) return undefined;
  const context: ValidationContext = {
    code: 'invalid_prompt_caching',
    message: 'Invalid OpenAI prompt caching options.',
    option: 'providerOptions.openai.promptCaching',
    provider: 'openai',
    ...(model ? { model } : {}),
  };
  const d = inspectRecord(value, context, context.option, ['key', 'retention']);
  const key = readValue(d, 'key');
  const retention = readValue(d, 'retention');
  if (hasValue(d, 'key') && (typeof key !== 'string' || !key.trim())) {
    invalid(context, 'non_empty_string', { path: `${context.option}.key` });
  }
  if (
    hasValue(d, 'retention') &&
    retention !== 'in_memory' &&
    retention !== '24h'
  ) {
    invalid(context, 'supported_retention', {
      path: `${context.option}.retention`,
    });
  }
  return {
    ...(hasValue(d, 'key') ? { key: key as string } : {}),
    ...(hasValue(d, 'retention')
      ? { retention: retention as '24h' | 'in_memory' }
      : {}),
  };
}

export function validateCompletionCacheOptions(options: {
  messages: CanonicalMessage[];
  model?: string;
  providerOptions?: unknown;
}): void {
  validateOpenAIProviderPromptCaching(options.providerOptions, options.model);
  validateAnthropicCacheControls(options);
}

function validateOpenAIProviderPromptCaching(
  providerOptions: unknown,
  model?: string,
): void {
  if (providerOptions === undefined) return;
  const context: ValidationContext = {
    code: 'invalid_prompt_caching',
    message: 'Invalid OpenAI prompt caching options.',
    option: 'providerOptions.openai.promptCaching',
    provider: 'openai',
    ...(model ? { model } : {}),
  };
  const providers = inspectRecord(providerOptions, context, 'providerOptions');
  const openai = readValue(providers, 'openai');
  if (openai === undefined) return;
  const d = inspectRecord(openai, context, 'providerOptions.openai');
  if (hasValue(d, 'promptCaching')) {
    validateOpenAIPromptCaching(readValue(d, 'promptCaching'), model);
  }
}

export function validateCacheControl(
  value: unknown,
  context: ValidationContext,
  path: string,
): CacheControl {
  const d = inspectRecord(value, context, path, ['type', 'ttl']);
  const ttl = readValue(d, 'ttl');
  if (readValue(d, 'type') !== 'ephemeral') {
    invalid(context, 'ephemeral_type', { path: `${path}.type` });
  }
  if (hasValue(d, 'ttl') && ttl !== '5m' && ttl !== '1h') {
    invalid(context, 'supported_ttl', { path: `${path}.ttl` });
  }
  return {
    type: 'ephemeral',
    ...(hasValue(d, 'ttl') ? { ttl: ttl as '1h' | '5m' } : {}),
  };
}

export function validateAnthropicCacheControls(options: {
  messages: CanonicalMessage[];
  model?: string;
  providerOptions?: unknown;
}): CacheControl | undefined {
  const context: ValidationContext = {
    code: 'invalid_cache_control',
    message: 'Invalid Anthropic cache control.',
    option: 'cacheControl',
    provider: 'anthropic',
    ...(options.model ? { model: options.model } : {}),
  };
  let topLevel: CacheControl | undefined;
  if (options.providerOptions !== undefined) {
    const providers = inspectRecord(
      options.providerOptions,
      context,
      'providerOptions',
    );
    const anthropic = readValue(providers, 'anthropic');
    if (anthropic !== undefined) {
      const d = inspectRecord(anthropic, context, 'providerOptions.anthropic');
      if (hasValue(d, 'cacheControl')) {
        topLevel = validateCacheControl(
          readValue(d, 'cacheControl'),
          context,
          'providerOptions.anthropic.cacheControl',
        );
      }
    }
  }
  options.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      const descriptor = Object.getOwnPropertyDescriptor(part, 'cacheControl');
      if (!descriptor) return;
      const path = `messages[${messageIndex}].content[${partIndex}].cacheControl`;
      if (!('value' in descriptor)) invalid(context, 'data_property', { path });
      validateCacheControl(descriptor.value, context, path);
    });
  });
  return topLevel;
}
