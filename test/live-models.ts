import type { CanonicalProvider } from '../src/types.js';

export interface LiveModelEnvironment {
  LIVE_ANTHROPIC_MODEL?: string;
  LIVE_GEMINI_MODEL?: string;
  LIVE_OPENAI_MODEL?: string;
  LIVE_REAL_ANTHROPIC_MODEL?: string;
  LIVE_REAL_GEMINI_MODEL?: string;
  LIVE_REAL_OPENAI_MODEL?: string;
}

export interface LiveModelMatrix {
  anthropic: string;
  gemini: string;
  openai: string;
}

export const defaultLiveModels: LiveModelMatrix = {
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-3.1-flash-lite',
  openai: 'gpt-5.6-luna',
};

export function getLiveModelMatrix(
  environment: LiveModelEnvironment = process.env,
): LiveModelMatrix {
  return {
    anthropic:
      environment.LIVE_ANTHROPIC_MODEL ??
      environment.LIVE_REAL_ANTHROPIC_MODEL ??
      defaultLiveModels.anthropic,
    gemini:
      environment.LIVE_GEMINI_MODEL ??
      environment.LIVE_REAL_GEMINI_MODEL ??
      defaultLiveModels.gemini,
    openai:
      environment.LIVE_OPENAI_MODEL ??
      environment.LIVE_REAL_OPENAI_MODEL ??
      defaultLiveModels.openai,
  };
}

/** Returns the deterministic temperature option supported by a live model. */
export function liveTemperature(
  provider: CanonicalProvider,
  model: string,
): { temperature: number } | Record<string, never> {
  return provider === 'openai' && model === defaultLiveModels.openai
    ? {}
    : { temperature: 0 };
}
