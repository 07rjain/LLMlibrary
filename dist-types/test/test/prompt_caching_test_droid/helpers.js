import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const currentDir = dirname(fileURLToPath(import.meta.url));
export function loadEnv() {
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
        const sep = trimmed.indexOf('=');
        if (sep < 0) {
            continue;
        }
        const key = trimmed.slice(0, sep).trim();
        if (!key || process.env[key]) {
            continue;
        }
        let value = trimmed.slice(sep + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
}
/**
 * Builds a long repeated string that exceeds the 1 024-token minimum needed
 * to trigger OpenAI and Anthropic prompt caching.
 */
export function buildLargePrefix(label, repeats = 160) {
    return Array.from({ length: repeats }, (_, i) => `${label} paragraph ${i + 1}: Policy states that refunds are valid within 30 days when proof of purchase is provided.`).join('\n');
}
export function summarize(response) {
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
export function log(provider, payload) {
    console.log(`[caching-droid][${provider}] ${JSON.stringify(payload, null, 2)}`);
}
