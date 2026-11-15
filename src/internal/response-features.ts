import { ProviderCapabilityError } from 'unified-llm-client/errors';
import { getResponseCapabilities } from 'unified-llm-client/models';
import type { CanonicalProvider, ProviderOptions } from '../types.js';

/** Apply per attempt so an unused fallback cannot invalidate a supported primary. */
export function applyResponseFeaturePolicy<
  T extends { model: string; providerOptions?: ProviderOptions },
>(options: T, provider: CanonicalProvider): T {
  const config = options.providerOptions;
  if (!config) return options;
  const policy = config.unsupportedFeaturePolicy ?? 'error';
  if (policy !== 'error' && policy !== 'omit') {
    throw new ProviderCapabilityError(
      'unsupportedFeaturePolicy must be "error" or "omit".',
      { model: options.model, provider },
    );
  }
  const support = getResponseCapabilities({
    id: options.model,
    provider,
    supportsVision: false,
  });
  const verbosity =
    config.openai?.verbosity !== undefined && !support.verbosity;
  const reasoning =
    config.openai?.reasoning !== undefined && !support.reasoningSummary;
  if (!verbosity && !reasoning) return options;
  const unsupported = [
    ...(verbosity ? ['openai.verbosity'] : []),
    ...(reasoning ? ['openai.reasoning'] : []),
  ];
  if (policy === 'error') {
    throw new ProviderCapabilityError(
      `Model "${options.model}" does not support ${unsupported.join(', ')} through this adapter. Remove these settings or set providerOptions.unsupportedFeaturePolicy to "omit".`,
      { model: options.model, provider, details: { unsupported } },
    );
  }
  const openai = { ...config.openai };
  if (verbosity) delete openai.verbosity;
  if (reasoning) delete openai.reasoning;
  return { ...options, providerOptions: { ...config, openai } };
}
