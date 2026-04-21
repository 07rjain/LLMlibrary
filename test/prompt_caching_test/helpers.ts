import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CanonicalResponse } from '../../src/types.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

export interface PromptCachingResponseSummary {
  cachedReadTokens: number;
  cachedTokens: number;
  cachedWriteTokens: number;
  costUSD: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  provider: string;
  textPreview: string;
}

export function loadPromptCachingEnv(): void {
  const envPath = resolve(currentDir, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key]) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

export function buildCachedPrefix(label: string, repeats = 160): string {
  return Array.from(
    { length: repeats },
    (_, index) =>
      `${label} section ${index + 1}: Refunds are available within 30 days when proof of purchase is provided.`,
  ).join('\n');
}

export function summarizeResponse(
  response: CanonicalResponse,
): PromptCachingResponseSummary {
  return {
    cachedReadTokens: response.usage.cachedReadTokens ?? 0,
    cachedTokens: response.usage.cachedTokens,
    cachedWriteTokens: response.usage.cachedWriteTokens ?? 0,
    costUSD: response.usage.costUSD,
    inputTokens: response.usage.inputTokens,
    model: response.model,
    outputTokens: response.usage.outputTokens,
    provider: response.provider,
    textPreview: response.text.trim().slice(0, 80),
  };
}

export function logPromptCachingResult(provider: string, payload: unknown): void {
  console.log(`[prompt-caching][${provider}] ${JSON.stringify(payload)}`);
}
