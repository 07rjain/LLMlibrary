import type { ModelInfo, ResponseCapabilities } from '../types.js';

/** Adapter coverage; provider/account restrictions can still apply. */
export function getResponseCapabilities(
  model: Pick<ModelInfo, 'id' | 'provider' | 'kind' | 'supportsVision'>,
): ResponseCapabilities {
  const completion = model.kind === undefined || model.kind === 'completion';
  const openai = completion && model.provider === 'openai';
  const gpt = /^gpt-[56](?:[.-]|$)/.test(model.id);
  return {
    pdfInput:
      completion &&
      model.supportsVision &&
      ['openai', 'anthropic', 'google'].includes(model.provider),
    verbosity: openai && gpt,
    reasoningSummary: openai && (gpt || /^o[34](?:[.-]|$)/.test(model.id)),
  };
}
