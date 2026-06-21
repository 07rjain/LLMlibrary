import { describe, expect, it } from 'vitest';
import { ModelRegistry } from '../src/models/registry.js';
import { anthropicUsageToCanonical, calcCostUSD, calcSpeechCostUSD, formatCost, geminiUsageToCanonical, openaiUsageToCanonical, speechUsageWithCost, usageWithCost, } from '../src/utils/cost.js';
describe('cost utilities', () => {
    const registry = new ModelRegistry();
    it('calculates cost for every launch model entry', () => {
        for (const model of registry.list()) {
            const cost = calcCostUSD({
                cachedReadTokens: 100,
                cachedWriteTokens: 50,
                inputTokens: 1000,
                model: model.id,
                outputTokens: 500,
            }, registry);
            const hasNonZeroPricing = model.inputPrice > 0 ||
                model.outputPrice > 0 ||
                (model.cacheReadPrice ?? 0) > 0 ||
                (model.cacheWritePrice ?? 0) > 0;
            if (hasNonZeroPricing) {
                expect(cost).toBeGreaterThan(0);
            }
            else {
                expect(cost).toBe(0);
            }
        }
    });
    it('matches the exact pricing formula for every launch model entry', () => {
        for (const model of registry.list()) {
            const inputTokens = 2_000;
            const outputTokens = 750;
            const cachedReadTokens = 400;
            const cachedWriteTokens = 200;
            const expected = (inputTokens / 1_000_000) * model.inputPrice +
                (outputTokens / 1_000_000) * model.outputPrice +
                (cachedReadTokens / 1_000_000) * (model.cacheReadPrice ?? model.inputPrice * 0.1) +
                (cachedWriteTokens / 1_000_000) * (model.cacheWritePrice ?? model.inputPrice * 1.25);
            expect(calcCostUSD({
                cachedReadTokens,
                cachedWriteTokens,
                inputTokens,
                model: model.id,
                outputTokens,
            }, registry)).toBeCloseTo(expected, 9);
        }
    });
    it('returns zero for unknown models', () => {
        expect(calcCostUSD({
            inputTokens: 1000,
            model: 'unknown-model',
            outputTokens: 500,
        })).toBe(0);
    });
    it('prices separately billable reasoning tokens at the output rate', () => {
        const gemini = registry.get('gemini-2.5-flash');
        const expected = (100 / 1_000_000) * gemini.inputPrice +
            (20 / 1_000_000) * gemini.outputPrice +
            (80 / 1_000_000) * gemini.outputPrice;
        expect(calcCostUSD({
            billableReasoningTokens: 80,
            inputTokens: 100,
            model: gemini.id,
            outputTokens: 20,
        }, registry)).toBeCloseTo(expected, 9);
    });
    it('formats costs consistently', () => {
        expect(formatCost(0)).toBe('$0.00');
        expect(formatCost(0.00234)).toBe('$0.0023');
        expect(formatCost(12.3456)).toBe('$12.35');
    });
    it('normalizes provider usage payloads', () => {
        expect(anthropicUsageToCanonical({
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 20,
            input_tokens: 100,
            output_tokens: 50,
        })).toEqual({
            cachedReadTokens: 20,
            cachedTokens: 60,
            cachedWriteTokens: 40,
            inputTokens: 100,
            outputTokens: 50,
        });
        expect(openaiUsageToCanonical({
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 25 },
            output_tokens: 50,
        })).toEqual({
            billedInputTokens: 75,
            cachedReadTokens: 25,
            cachedTokens: 25,
            inputTokens: 100,
            outputTokens: 50,
        });
        expect(openaiUsageToCanonical({
            completion_tokens: 20,
            prompt_tokens: 80,
            prompt_tokens_details: { cached_tokens: 10 },
        })).toEqual({
            billedInputTokens: 70,
            cachedReadTokens: 10,
            cachedTokens: 10,
            inputTokens: 80,
            outputTokens: 20,
        });
        expect(geminiUsageToCanonical({
            cachedContentTokenCount: 12,
            candidatesTokenCount: 50,
            promptTokenCount: 100,
            thoughtsTokenCount: 7,
        })).toEqual({
            billedInputTokens: 88,
            billableReasoningTokens: 7,
            cachedReadTokens: 12,
            cachedTokens: 12,
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 7,
        });
        expect(anthropicUsageToCanonical(undefined)).toEqual({
            cachedReadTokens: 0,
            cachedTokens: 0,
            cachedWriteTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
        });
        expect(openaiUsageToCanonical(undefined)).toEqual({
            billedInputTokens: 0,
            cachedReadTokens: 0,
            cachedTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
        });
        expect(geminiUsageToCanonical(undefined)).toEqual({
            billedInputTokens: 0,
            cachedReadTokens: 0,
            cachedTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
        });
    });
    it('attaches formatted cost to usage metrics', () => {
        const model = registry.get('claude-sonnet-4-6');
        expect(usageWithCost(model, {
            cachedReadTokens: 20,
            cachedTokens: 60,
            cachedWriteTokens: 40,
            inputTokens: 100,
            outputTokens: 50,
        })).toMatchObject({
            cachedTokens: 60,
            cost: '$0.0012',
            inputTokens: 100,
            outputTokens: 50,
        });
    });
    it('uses fallback cache pricing when a model does not define cache prices', () => {
        const gemini = registry.get('gemini-2.5-flash');
        expect(calcCostUSD({
            cachedReadTokens: 100,
            cachedWriteTokens: 50,
            inputTokens: 1000,
            model: gemini.id,
            outputTokens: 500,
        }, registry)).toBeGreaterThan(0);
        expect(usageWithCost(gemini, {
            cachedReadTokens: 100,
            cachedTokens: 150,
            cachedWriteTokens: 50,
            inputTokens: 1000,
            outputTokens: 500,
        }).costUSD).toBeGreaterThan(0);
    });
    it('does not double-count cached OpenAI input tokens', () => {
        const openai = registry.get('gpt-4o');
        const usage = openaiUsageToCanonical({
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 25 },
            output_tokens: 50,
        });
        const expected = (75 / 1_000_000) * openai.inputPrice +
            (25 / 1_000_000) * (openai.cacheReadPrice ?? openai.inputPrice * 0.1) +
            (50 / 1_000_000) * openai.outputPrice;
        expect(usageWithCost(openai, usage).costUSD).toBeCloseTo(expected, 9);
    });
    it('does not double-count OpenAI reasoning tokens already included in output tokens', () => {
        const openai = registry.get('o3');
        const usage = openaiUsageToCanonical({
            input_tokens: 100,
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 40 },
        });
        const expected = (100 / 1_000_000) * openai.inputPrice +
            (50 / 1_000_000) * openai.outputPrice;
        expect(usageWithCost(openai, usage)).toMatchObject({
            costUSD: expect.closeTo(expected, 9),
            outputTokens: 50,
            reasoningTokens: 40,
        });
        expect(usageWithCost(openai, usage)).not.toHaveProperty('billableReasoningTokens');
    });
    it('does not double-count cached Gemini input tokens', () => {
        const gemini = registry.get('gemini-2.5-flash');
        const usage = geminiUsageToCanonical({
            cachedContentTokenCount: 12,
            candidatesTokenCount: 50,
            promptTokenCount: 100,
        });
        const expected = (88 / 1_000_000) * gemini.inputPrice +
            (12 / 1_000_000) * (gemini.cacheReadPrice ?? gemini.inputPrice * 0.1) +
            (50 / 1_000_000) * gemini.outputPrice;
        expect(usageWithCost(gemini, usage).costUSD).toBeCloseTo(expected, 9);
    });
    it('prices Gemini thoughts without exposing the internal billable reasoning field', () => {
        const gemini = registry.get('gemini-2.5-flash');
        const usage = geminiUsageToCanonical({
            cachedContentTokenCount: 12,
            candidatesTokenCount: 50,
            promptTokenCount: 100,
            thoughtsTokenCount: 25,
        });
        const expected = (88 / 1_000_000) * gemini.inputPrice +
            (12 / 1_000_000) * (gemini.cacheReadPrice ?? gemini.inputPrice * 0.1) +
            ((50 + 25) / 1_000_000) * gemini.outputPrice;
        const withCost = usageWithCost(gemini, usage);
        expect(withCost.costUSD).toBeCloseTo(expected, 9);
        expect(withCost.reasoningTokens).toBe(25);
        expect(withCost).not.toHaveProperty('billableReasoningTokens');
    });
    it('calculates text-to-speech costs from text and audio billing units', () => {
        const result = calcSpeechCostUSD({
            inputTokens: 1_000,
            model: 'gpt-4o-mini-tts',
            outputAudioSeconds: 10,
        }, registry);
        expect(result.costUSD).toBeCloseTo(0.0006 + 0.0025, 9);
        expect(result.costBreakdown).toEqual([
            {
                amountUSD: 0.0006,
                estimated: true,
                label: 'Text input',
                quantity: 1000,
                rateUSD: 0.6,
                unit: 'text_input_token',
            },
            {
                amountUSD: 0.0025,
                estimated: true,
                label: 'Output audio duration',
                quantity: 10,
                rateUSD: 0.00025,
                unit: 'audio_second',
            },
        ]);
    });
    it('attaches speech cost and billing units to speech usage metrics', () => {
        const model = registry.get('gpt-4o-mini-transcribe');
        const usage = speechUsageWithCost(model, {
            estimated: true,
            inputAudioSeconds: 30,
            outputCharacters: 120,
            outputTokens: 24,
        });
        expect(usage.costUSD).toBeCloseTo(0.0015, 9);
        expect(usage.cost).toBe('$0.0015');
        expect(usage.billingUnits?.inputAudioSeconds).toBe(30);
        expect(usage.estimated).toBe(true);
    });
    it('preserves audio-token speech usage even when no speech cost is available', () => {
        const model = {
            contextWindow: 1000,
            id: 'unpriced-audio-token-model',
            inputPrice: 0,
            kind: 'speech',
            lastUpdated: '2026-05-19',
            outputPrice: 0,
            provider: 'openai',
            supportsStreaming: false,
            supportsTools: false,
            supportsVision: false,
        };
        const usage = speechUsageWithCost(model, {
            audioInputTokens: 7,
            audioOutputTokens: 11,
            estimated: false,
        });
        expect(usage.audioInputTokens).toBe(7);
        expect(usage.audioOutputTokens).toBe(11);
        expect(usage.billingUnits?.audioInputTokens).toBe(7);
        expect(usage.billingUnits?.audioOutputTokens).toBe(11);
        expect(usage.cost).toBeUndefined();
        expect(usage.costUSD).toBeUndefined();
        expect(usage.estimated).toBe(false);
        const defaultEstimatedUsage = speechUsageWithCost(model, {
            audioInputTokens: 1,
        });
        expect(defaultEstimatedUsage.estimated).toBe(true);
    });
    it('returns speech billing units without cost for unknown or unpriced models', () => {
        const unpriced = new ModelRegistry({
            'custom-speech': {
                contextWindow: 1000,
                inputPrice: 0,
                kind: 'speech',
                lastUpdated: '2026-05-19',
                outputPrice: 0,
                provider: 'openai',
                supportsStreaming: false,
                supportsTools: false,
                supportsVision: false,
            },
        });
        expect(calcSpeechCostUSD({
            inputCharacters: 10,
            model: 'missing-speech-model',
        }).costUSD).toBeUndefined();
        expect(calcSpeechCostUSD({
            inputCharacters: 10,
            model: 'custom-speech',
        }, unpriced)).toMatchObject({
            billingUnits: { inputCharacters: 10 },
            costBreakdown: [],
            estimated: true,
        });
        const noApplicableUnits = new ModelRegistry({
            'priced-speech': {
                contextWindow: 1000,
                inputPrice: 0,
                kind: 'speech',
                lastUpdated: '2026-05-19',
                outputPrice: 0,
                provider: 'openai',
                speechPrices: { textInputTokenPrice: 1 },
                supportsStreaming: false,
                supportsTools: false,
                supportsVision: false,
            },
        });
        expect(calcSpeechCostUSD({
            inputTokens: 0,
            model: 'priced-speech',
        }, noApplicableUnits).costUSD).toBeUndefined();
    });
    it('calculates every supported speech price unit and ignores invalid line items', () => {
        const custom = new ModelRegistry({
            'all-units-speech': {
                contextWindow: 1000,
                inputPrice: 0,
                kind: 'speech',
                lastUpdated: '2026-05-19',
                outputPrice: 0,
                provider: 'openai',
                speechPrices: {
                    audioInputTokenPrice: 1,
                    audioOutputTokenPrice: 2,
                    characterInputPrice: 3,
                    characterOutputPrice: 4,
                    inputAudioSecondPrice: 0.5,
                    outputAudioSecondPrice: 0.25,
                    requestPrice: 0.01,
                    textInputTokenPrice: 5,
                    textOutputTokenPrice: 6,
                },
                supportsStreaming: false,
                supportsTools: false,
                supportsVision: false,
            },
        });
        const result = calcSpeechCostUSD({
            audioInputTokens: 1_000_000,
            audioOutputTokens: 1_000_000,
            estimated: false,
            inputAudioSeconds: 2,
            inputCharacters: 1_000_000,
            inputTokens: 1_000_000,
            model: 'all-units-speech',
            outputAudioSeconds: 4,
            outputCharacters: 1_000_000,
            outputTokens: 1_000_000,
        }, custom);
        expect(result.estimated).toBe(false);
        expect(result.costBreakdown.map((line) => line.unit)).toEqual([
            'text_input_token',
            'text_output_token',
            'audio_input_token',
            'audio_output_token',
            'audio_second',
            'audio_second',
            'character',
            'character',
            'request',
        ]);
        expect(result.costUSD).toBeCloseTo(23.01, 9);
    });
});
