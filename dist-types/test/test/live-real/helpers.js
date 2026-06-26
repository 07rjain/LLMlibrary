import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { LLMClient } from '../../src/client.js';
const ENV_PATH = resolve(process.cwd(), '.env');
export const liveRealEnabled = process.env.LIVE_REAL_TESTS === '1';
export const providerModels = {
    anthropic: process.env.LIVE_REAL_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    gemini: process.env.LIVE_REAL_GEMINI_MODEL ?? 'gemini-2.5-flash',
    geminiThinking: process.env.LIVE_REAL_GEMINI_THINKING_MODEL ?? 'gemini-2.5-flash',
    openai: process.env.LIVE_REAL_OPENAI_MODEL ?? 'gpt-4o-mini',
};
export const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
loadDotEnvSafely();
export function hasEnv(name) {
    return typeof process.env[name] === 'string' && process.env[name].length > 0;
}
export function requireLiveEnv(name) {
    if (!hasEnv(name)) {
        throw new Error(`${name} is required for this live-real test.`);
    }
}
export function runId(prefix = 'live') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
export function liveClient() {
    return LLMClient.fromEnv({
        budgetExceededAction: 'throw',
        retryOptions: {
            maxAttempts: 2,
        },
    });
}
export function weatherTool(execute) {
    return {
        description: 'Returns deterministic weather for one city.',
        execute: execute ??
            ((args) => ({
                city: String(args.city),
                condition: 'clear',
                temperatureC: 21,
            })),
        name: 'get_weather',
        parameters: {
            additionalProperties: false,
            properties: {
                city: {
                    description: 'City name.',
                    type: 'string',
                },
            },
            required: ['city'],
            type: 'object',
        },
    };
}
export async function collectStream(stream) {
    let text = '';
    let done;
    let toolCalls = 0;
    for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
            text += chunk.delta;
        }
        if (chunk.type === 'tool-call-start') {
            toolCalls += 1;
        }
        if (chunk.type === 'done') {
            done = chunk;
        }
    }
    return {
        done,
        text,
        toolCalls,
    };
}
export function assertCanonicalResponse(response, expectedProvider) {
    expect(response.provider).toBe(expectedProvider);
    expect(response.model.length).toBeGreaterThan(0);
    expect(Array.isArray(response.content)).toBe(true);
    expect(Array.isArray(response.toolCalls)).toBe(true);
    expect(typeof response.text).toBe('string');
    expect(response.raw).toBeDefined();
    expect(['stop', 'length', 'tool_call', 'content_filter', 'error']).toContain(response.finishReason);
    assertUsage(response.usage);
}
export function assertUsage(usage) {
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.cachedTokens).toBeGreaterThanOrEqual(0);
    expect(usage.costUSD).toBeGreaterThanOrEqual(0);
    expect(usage.cost).toMatch(/^\$/);
}
export function expectNoSecretLeak(value) {
    const serialized = JSON.stringify(value);
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
        const secret = process.env[name];
        if (secret) {
            expect(serialized).not.toContain(secret);
        }
    }
}
export function strictJsonObject(value) {
    expect(value).toBeTruthy();
    expect(typeof value).toBe('object');
    expect(Array.isArray(value)).toBe(false);
    return value;
}
function loadDotEnvSafely() {
    if (!existsSync(ENV_PATH)) {
        return;
    }
    const text = readFileSync(ENV_PATH, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }
        const key = trimmed.slice(0, separatorIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            continue;
        }
        if (process.env[key] !== undefined) {
            continue;
        }
        process.env[key] = parseEnvValue(trimmed.slice(separatorIndex + 1).trim());
    }
}
function parseEnvValue(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    const hashIndex = value.indexOf(' #');
    return hashIndex === -1 ? value : value.slice(0, hashIndex).trimEnd();
}
