import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const currentDir = dirname(fileURLToPath(import.meta.url));
export function loadPromptCachingEnv() {
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
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
}
export function buildCachedPrefix(label, repeats = 160) {
    return Array.from({ length: repeats }, (_, index) => `${label} section ${index + 1}: Refunds are available within 30 days when proof of purchase is provided.`).join('\n');
}
export function summarizeResponse(response) {
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
export function logPromptCachingResult(provider, payload) {
    console.log(`[prompt-caching][${provider}] ${JSON.stringify(payload)}`);
}
