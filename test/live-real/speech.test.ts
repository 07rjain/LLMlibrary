import { describe, expect, it } from 'vitest';

import type { SpeechUsageEvent } from '../../src/usage.js';
import { LLMClient } from '../../src/client.js';
import type { SpeechUsageMetrics } from '../../src/types.js';
import { expectNoSecretLeak, hasEnv, liveRealEnabled } from './helpers.js';

const speechLiveEnabled =
  liveRealEnabled &&
  process.env.LIVE_REAL_SPEECH === '1' &&
  hasEnv('OPENAI_API_KEY');
const liveDescribe = speechLiveEnabled ? describe : describe.skip;

function assertSpeechUsage(usage: SpeechUsageMetrics | undefined): void {
  if (!usage) return;

  if (usage.costUSD !== undefined) {
    expect(Number.isFinite(usage.costUSD)).toBe(true);
    expect(usage.costUSD).toBeGreaterThanOrEqual(0);
  }
  if (usage.cost !== undefined) {
    expect(usage.cost).toMatch(/^\$/);
  }
}

liveDescribe('live-real OpenAI speech', () => {
  it('round-trips TTS audio through STT without leaking media or prompts', async () => {
    const ttsModel =
      process.env.LIVE_REAL_OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts';
    const sttModel =
      process.env.LIVE_REAL_OPENAI_STT_MODEL ?? 'gpt-4o-mini-transcribe';
    const prompt = 'Say SPEECH_SMOKE_OK.';
    const events: SpeechUsageEvent[] = [];
    const client = LLMClient.fromEnv({
      budgetExceededAction: 'throw',
      retryOptions: { maxAttempts: 1 },
      usageLogger: {
        logSpeech: (event) => {
          events.push(event);
        },
      },
    });

    const speech = await client.speak({
      budgetUsd: 0.1,
      estimatedOutputSeconds: 2,
      format: 'wav',
      input: prompt,
      maxOutputSeconds: 2,
      model: ttsModel,
      provider: 'openai',
      voice: 'alloy',
    });

    expect(speech.provider).toBe('openai');
    expect(speech.model).toBe(ttsModel);
    expect(speech.format).toBe('wav');
    expect(speech.mediaType).toMatch(/^audio\//);
    expect(speech.audio).toBeInstanceOf(Uint8Array);
    expect(speech.audio.byteLength).toBeGreaterThan(0);
    assertSpeechUsage(speech.usage);

    const transcription = await client.transcribe({
      budgetUsd: 0.1,
      input: {
        file: speech.audio,
        filename: 'speech-smoke.wav',
        mediaType: 'audio/wav',
      },
      inputAudioSeconds: 2,
      model: sttModel,
      provider: 'openai',
      responseFormat: 'text',
    });

    expect(transcription.provider).toBe('openai');
    expect(transcription.model).toBe(sttModel);
    expect(typeof transcription.text).toBe('string');
    expect(transcription.text.trim().length).toBeGreaterThan(0);
    assertSpeechUsage(transcription.usage);

    const logged = JSON.stringify(events);
    expectNoSecretLeak(events);
    expect(logged).not.toContain(prompt);
    expect(logged).not.toContain(Buffer.from(speech.audio).toString('base64'));
    expect(logged).not.toContain(transcription.text);
  }, 120_000);
});
