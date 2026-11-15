import { ProviderCapabilityError } from 'unified-llm-client/errors';
import type { ProviderOptions, TranscriptionRequestOptions } from '../types.js';

interface CurrentModelOptions {
  model: string;
  providerOptions?: ProviderOptions;
  temperature?: number;
}

export function assertCurrentAnthropicOptions(
  options: CurrentModelOptions,
): void {
  const thinking = options.providerOptions?.anthropic?.thinking?.type;
  const effortLevel = options.providerOptions?.anthropic?.effort;
  const newModel = [
    'claude-fable-5-2',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
  ].includes(options.model);
  const lightEffort = effortLevel !== 'xhigh' && effortLevel !== 'max';
  if (
    (newModel && thinking === 'enabled') ||
    (newModel &&
      thinking === 'disabled' &&
      (options.model !== 'claude-haiku-5-5' || !lightEffort)) ||
    (thinking === 'between_tools' &&
      (options.model !== 'claude-sonnet-5-5' || !lightEffort))
  ) {
    throw new ProviderCapabilityError(
      'This model and effort do not support the requested thinking mode. Use adaptive thinking.',
      {
        model: options.model,
        provider: 'anthropic',
      },
    );
  }
}

export function assertCurrentGeminiOptions(options: CurrentModelOptions): void {
  if (options.model.startsWith('gemini-4-')) {
    const google = options.providerOptions?.google;
    const thinking = google?.thinking;
    if (
      google?.promptCaching?.cachedContent !== undefined ||
      thinking?.budgetTokens !== undefined ||
      thinking?.level === 'minimal' ||
      (thinking?.level === 'xhigh' && options.model !== 'gemini-4-hydrogen')
    ) {
      throw new ProviderCapabilityError(
        'Gemini 4 requires supported thinking levels and implicit caching. Explicit caches and thinking budgets are unsupported.',
        {
          model: options.model,
          provider: 'google',
        },
      );
    }
  }
}

export function assertCurrentOpenAIOptions(options: CurrentModelOptions): void {
  if (
    ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'].includes(
      options.model,
    )
  ) {
    const effort = options.providerOptions?.openai?.reasoning?.effort;
    if (
      effort === 'minimal' ||
      (effort === 'none' &&
        ['gpt-6-astra', 'gpt-6.1-sol'].includes(options.model))
    ) {
      throw new ProviderCapabilityError(
        'This GPT-6 model does not support the requested reasoning effort.',
        { model: options.model, provider: 'openai' },
      );
    }
    if (options.temperature !== undefined && effort !== 'none') {
      throw new ProviderCapabilityError(
        'GPT-6 sampling requires explicit reasoning effort "none" on a model that supports it.',
        { model: options.model, provider: 'openai' },
      );
    }
  }
}

export function assertCurrentTranscriptionOptions(
  options: TranscriptionRequestOptions & { model: string },
): void {
  if (
    options.model === 'gpt-transcribe' &&
    (options.diarization ||
      options.temperature !== undefined ||
      (options.responseFormat !== undefined &&
        options.responseFormat !== 'json') ||
      (options.timestampGranularities?.length ?? 0) > 0 ||
      Object.keys(options.providerOptions?.openai ?? {}).length > 0)
  ) {
    throw new ProviderCapabilityError(
      'gpt-transcribe supports ordinary JSON file transcription. Legacy diarization, timestamps, sampling, and speaker options require a compatible model.',
      {
        model: options.model,
        provider: 'openai',
      },
    );
  }
}

export function supportsGeminiSamplingParameters(model: string): boolean {
  return (
    !model.startsWith('gemini-4-') &&
    !['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].includes(
      model,
    )
  );
}
