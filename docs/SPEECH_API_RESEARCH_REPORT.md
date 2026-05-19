# Speech API Research Report

Date: 2026-05-19

This report evaluates adding speech-to-text and text-to-speech support to `unified-llm-client` without disrupting the existing completion, streaming, conversation, embeddings, retrieval, model discovery, and usage logging surfaces.

## Executive Summary

The recommended approach is to add speech as explicit top-level client verbs:

```ts
const transcript = await client.transcribe({
  input: { data: audioBase64, mediaType: 'audio/mpeg' },
  model: 'gpt-4o-mini-transcribe',
});

const speech = await client.speak({
  input: 'Your appointment is confirmed for 10 AM.',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  format: 'mp3',
});
```

Do not fold these into `complete()` or `conversation()` in the first implementation. Speech is a separate modality with different payload types, response bodies, costs, size limits, streaming behavior, safety issues, and persistence requirements.

## Implementation Status

The v1 implementation now ships the OpenAI batch path described in this report:

- `client.speak()` for OpenAI text-to-speech.
- `client.transcribe()` for OpenAI speech-to-text.
- `LLMClient.mock()` support for queued speech and transcription responses.
- `SpeechUsageMetrics`, `SpeechPriceBook`, `calcSpeechCostUSD()`, and `speechUsageWithCost()`.
- `PostgresUsageLogger.logSpeech()`, `client.getSpeechUsage()`, and `client.exportSpeechUsage()`.
- A separate Postgres speech usage table named `${tableName}_speech`.

Gemini speech and realtime speech remain future work. Anthropic remains explicitly unsupported for speech.

Recommended first scope:

- `client.transcribe()` for batch speech-to-text.
- `client.speak()` for batch text-to-speech.
- OpenAI implementation first because it has dedicated STT and TTS REST endpoints.
- Gemini implementation second for TTS and prompt-based audio transcription, with clear caveats.
- Anthropic should return an explicit unsupported-provider error for both methods until Anthropic ships first-party speech endpoints.
- No realtime voice in v1. Realtime should be a separate later API because it needs WebSocket/WebRTC session state, event streams, microphone chunking, and cancellation semantics.

## Current Provider Reality

### OpenAI

OpenAI has dedicated REST endpoints:

- Speech generation: `POST /v1/audio/speech`
- Transcription: `POST /v1/audio/transcriptions`
- Translation: `POST /v1/audio/translations`

Useful models to seed:

| Capability | Recommended model | Alternatives | Notes |
|---|---|---|---|
| Text to speech | `gpt-4o-mini-tts` | `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts-2025-03-20`, `gpt-4o-mini-tts-2025-12-15` | Best first default because it supports voice instructions and modern token-priced output. The current snapshot is `gpt-4o-mini-tts-2025-12-15`. |
| Speech to text | `gpt-4o-mini-transcribe` | `gpt-4o-transcribe`, `gpt-4o-mini-transcribe-2025-03-20`, `gpt-4o-mini-transcribe-2025-12-15`, `whisper-1` | Mini is the default cost/performance choice; full model can be user-selected. The current mini snapshot is `gpt-4o-mini-transcribe-2025-12-15`. |
| Diarization | `gpt-4o-transcribe-diarize` | none in the old Whisper path | Should be optional because output shape is different and speaker references add request complexity. |
| Realtime voice | out of v1 scope | `gpt-realtime-2`, `gpt-realtime-translate`, `gpt-realtime-whisper`, `gpt-realtime`, `gpt-realtime-mini`, `gpt-realtime-1.5` | These are Realtime API models, not simple batch REST speech endpoints. Treat them as a later `client.realtime()` design. |

Important OpenAI constraints:

- `gpt-4o-mini-tts` currently documents a maximum of 2000 input tokens.
- OpenAI speech output formats include `mp3`, `opus`, `aac`, `flac`, `wav`, and `pcm`.
- OpenAI TTS speed is a request parameter from `0.25` to `4.0`.
- Voice instructions work with `gpt-4o-mini-tts`, but not with `tts-1` or `tts-1-hd`.
- Transcription file uploads are currently limited to 25 MB and support common audio/video containers such as `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, and `webm`.
- OpenAI transcription can stream transcript deltas for supported models, but batch transcription should be the first library surface.
- `gpt-realtime-whisper` is the current streaming STT model for low-latency transcript deltas from live audio. It is duration-priced and belongs in a later realtime API surface, not the first batch `transcribe()` method.

### Google Gemini

Gemini has speech and audio capability through `generateContent`, not a symmetric pair of dedicated STT/TTS endpoints in the same way OpenAI does.

Useful models to seed:

| Capability | Recommended model | Alternatives | Notes |
|---|---|---|---|
| Text to speech through Google AI Gemini API | `gemini-3.1-flash-tts-preview` | `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` | The live Gemini API model list returns all three through `generateContent`. `gemini-3.1-flash-tts-preview` is the current Google AI docs example. |
| Text to speech through Google Cloud TTS / Vertex | out of current library scope | `gemini-2.5-flash-tts`, `gemini-2.5-pro-tts`, `gemini-2.5-flash-lite-preview-tts` | These use Google Cloud/Vertex auth and endpoints, not the current Gemini API key adapter. |
| Prompt-based speech to text | provider-selected multimodal Gemini model | `gemini-3-flash-preview` when available | This is audio understanding through `generateContent`, not a dedicated STT endpoint. |
| Realtime/native audio | out of v1 scope | `gemini-2.5-flash-native-audio-latest`, preview native-audio snapshots | These use Live API / bidirectional generation semantics and should not be mixed into batch `transcribe()`. |

Important Gemini constraints:

- TTS accepts text-only inputs and produces audio-only outputs.
- Gemini TTS is preview and does not support streaming.
- The Google AI Gemini API TTS live model list currently reports 8192 input tokens and 16384 output tokens for the returned TTS models, while the public guide still describes a 32k-token TTS session limit. Verify limits immediately before implementation.
- Gemini audio understanding can transcribe, translate, summarize, timestamp, and detect emotion, but the output is generative text and should be treated as model output rather than deterministic ASR.
- Inline audio requests have a 20 MB total request limit; larger files should use the Gemini Files API.
- Gemini docs explicitly say the Gemini API is not for realtime transcription and recommend the Live API or Google Cloud Speech-to-Text for realtime/dedicated STT.

### Anthropic

Anthropic's current direct API docs list Messages, Message Batches, Token Counting, Models, Files, Skills, Agents, Sessions, and Environments. Current Claude model docs describe text and image input with text output, but no first-party speech-to-text or text-to-speech endpoint.

Recommended behavior:

- `client.transcribe({ provider: 'anthropic' })` should throw `ProviderCapabilityError`.
- `client.speak({ provider: 'anthropic' })` should throw `ProviderCapabilityError`.
- Do not fake Anthropic support through third-party speech services inside this library. That would violate the current provider boundary.

## API Design Recommendation

Add two narrow top-level APIs:

```ts
type SpeechProvider = 'openai' | 'google' | 'mock';

interface AudioInput {
  data?: string;
  url?: string;
  file?: Blob | ArrayBuffer | Uint8Array;
  mediaType: string;
  filename?: string;
}

interface TranscriptionRequestOptions {
  input: AudioInput;
  model?: string;
  provider?: SpeechProvider;
  language?: string;
  prompt?: string;
  responseFormat?: 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt';
  timestampGranularities?: Array<'word' | 'segment'>;
  diarization?: boolean;
  signal?: AbortSignal;
  tenantId?: string;
  botId?: string;
  providerOptions?: {
    google?: {
      instruction?: string;
      responseSchema?: unknown;
      useFilesApi?: boolean | 'auto';
    };
    openai?: {
      include?: string[];
      knownSpeakerNames?: string[];
      knownSpeakerReferences?: string[];
    };
  };
}

interface TranscriptionResponse {
  text: string;
  language?: string;
  durationSeconds?: number;
  segments?: TranscriptionSegment[];
  words?: TranscriptionWord[];
  model: string;
  provider: SpeechProvider;
  raw: unknown;
  usage?: SpeechUsageMetrics;
}

interface SpeechRequestOptions {
  input: string;
  model?: string;
  provider?: SpeechProvider;
  voice?: string | { id: string };
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  instructions?: string;
  signal?: AbortSignal;
  tenantId?: string;
  botId?: string;
  providerOptions?: {
    google?: {
      speakerVoiceConfigs?: Array<{ speaker: string; voiceName: string }>;
    };
    openai?: {
      streamFormat?: 'audio' | 'sse';
    };
  };
}

interface SpeechResponse {
  audio: Uint8Array;
  format: string;
  mediaType: string;
  model: string;
  provider: SpeechProvider;
  raw: unknown;
  usage?: SpeechUsageMetrics;
}
```

Why separate verbs:

- `complete()` returns `CanonicalResponse` with text/tool content and token usage; TTS returns binary audio.
- `stream()` currently streams text/tool chunks; realtime audio streaming needs different chunk types and transport assumptions.
- `conversation()` persists text message history; audio blobs should not automatically be stored in session history.
- Embeddings already established the right pattern: a separate stateless verb for a separate model kind.

## Model Registry Changes

Extend model metadata rather than adding ad hoc checks:

```ts
kind?: 'completion' | 'embedding' | 'speech' | 'transcription';
supportedOutputModalities?: Array<'audio' | 'text'>;
supportedInputModalities?: Array<'audio' | 'document' | 'image' | 'text' | 'video'>;
```

Seed only stable defaults and let users register newer models:

- `gpt-4o-mini-tts`
- `gpt-4o-mini-tts-2025-12-15`
- `tts-1`
- `tts-1-hd`
- `gpt-4o-mini-transcribe`
- `gpt-4o-mini-transcribe-2025-12-15`
- `gpt-4o-transcribe`
- `gpt-4o-transcribe-diarize`
- `whisper-1`
- `gemini-3.1-flash-tts-preview`
- `gemini-2.5-flash-preview-tts`
- `gemini-2.5-pro-preview-tts`

Keep `client.models.listRemote({ provider })` as discovery-only. Do not auto-register speech models from remote discovery because provider model list responses do not always include enough pricing, modality, and endpoint semantics for budget validation.

## Architecture Impact

### Provider Adapters

Add optional methods to provider adapters:

- `OpenAIAdapter.transcribe()`
- `OpenAIAdapter.speak()`
- `GeminiAdapter.transcribe()`
- `GeminiAdapter.speak()`

Anthropic does not need stub methods if the client dispatch layer throws unsupported-provider errors before adapter dispatch.

### Type System

Add speech-specific types to `src/types.ts` or a new `src/speech.ts` if the type block becomes too large. A separate `src/speech.ts` is cleaner if the implementation includes segment, word, diarization, and voice types.

### Usage And Cost

Current `UsageMetrics` is text-token oriented. Speech usage may be:

- text input tokens
- audio input tokens
- audio output tokens
- output duration seconds
- file duration seconds
- estimated cost when provider usage is incomplete

Recommended shape:

```ts
interface SpeechUsageMetrics {
  audioInputTokens?: number;
  audioOutputTokens?: number;
  cost?: string;
  costUSD?: number;
  durationSeconds?: number;
  estimated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}
```

Do not force speech into `UsageMetrics` unless the logger is also updated to distinguish text generation, embeddings, transcription, and speech generation events.

### Streaming

Initial v1 should be batch-only:

- `client.transcribe()`
- `client.speak()`

Later additions:

- `client.transcribeStream()` for OpenAI transcription delta events.
- `client.speakStream()` for OpenAI SSE/audio streams.
- `client.realtime()` as a separate stateful API if you want live voice agents.

This avoids contaminating the existing `StreamChunk` union, which is designed for text/tool events.

### Storage

Do not persist audio bytes by default.

Recommended app-owned storage pattern:

- Store uploaded/source audio in object storage such as S3, R2, GCS, or Supabase Storage.
- Store transcript text, segment metadata, provider, model, duration, and object-storage key in the app database.
- Store only references in session history if needed.
- Redact or avoid logging raw transcript text when voice data may include personal data.

## What To Consider Before Adding Speech

### Security And Privacy

Voice data is often biometric or personally identifying. Production apps should require explicit consent for recording and should define retention windows. Logs should not include raw audio, base64 payloads, or full transcripts unless the app has a clear policy.

### Provider Semantics Are Not Equivalent

OpenAI STT is a dedicated transcription endpoint. Gemini STT is prompt-based audio understanding. These will not behave identically:

- OpenAI is better for predictable ASR output.
- Gemini is useful when the same call should transcribe, summarize, translate, classify, or extract structured fields from audio.
- Anthropic is currently unsupported directly.

The docs should call this out so users do not assume provider swapping is as clean as text completions.

### Audio Payload Size

Binary payloads are much larger than text prompts. The implementation needs:

- multipart/form-data support for OpenAI STT
- JSON/base64 or Files API handling for Gemini
- request size validation before provider calls
- no accidental base64 logging

### Runtime Compatibility

Node, browser, Cloudflare Workers, and edge runtimes differ in `Blob`, `File`, `FormData`, `Buffer`, and stream support. Keep inputs broad but normalize internally:

- `Uint8Array`
- `ArrayBuffer`
- `Blob` / `File` when available
- base64 string
- URL/provider file URI where supported

### Output Handling

TTS returns binary audio. The client should return `Uint8Array` plus metadata, not write files. Writing files belongs in user code.

### Cost And Budgeting

Speech has different units than text:

- OpenAI modern speech models may price audio tokens.
- Some legacy STT paths price by duration.
- Provider usage fields vary by model and response format.

Budget guards should initially support explicit user-provided budgets only when the registry has enough pricing data. Otherwise, mark usage as `estimated: true` or omit `costUSD`.

### Testing

Unit tests should mock provider HTTP endpoints:

- OpenAI speech JSON request returns binary bytes.
- OpenAI transcription multipart request returns JSON.
- Gemini TTS returns inline audio data in `generateContent`.
- Gemini transcription returns text/JSON from `generateContent`.
- Unsupported Anthropic calls throw `ProviderCapabilityError`.

Live tests should be opt-in, small, and avoid committing audio fixtures with sensitive content.

## Recommended Implementation Plan

1. Add speech types.
   - Add `SpeechProvider`, `SpeechRequestOptions`, `SpeechResponse`, `TranscriptionRequestOptions`, `TranscriptionResponse`, segment/word types, and `SpeechUsageMetrics`.

2. Extend model registry.
   - Add model kinds `speech` and `transcription`.
   - Add output modalities.
   - Seed OpenAI speech/transcription models and selected Gemini preview speech/audio models.

3. Add `client.speak()` and `client.transcribe()`.
   - Resolve model/provider similarly to `embed()`.
   - Validate kind and provider.
   - Dispatch to provider adapter.
   - Log usage only after the usage event type can represent speech cleanly.

4. Implement OpenAI first.
   - `speak()` calls `POST /v1/audio/speech`.
   - `transcribe()` calls `POST /v1/audio/transcriptions`.
   - Normalize binary audio response into `Uint8Array`.
   - Normalize transcript text, words, segments, language, duration, and usage.

5. Implement Gemini second.
   - `speak()` calls `generateContent` with audio response modality and speech config.
   - `transcribe()` calls `generateContent` with audio input and a default transcript instruction.
   - Use inline audio under the documented request limit and expose `useFilesApi: 'auto'` as a future enhancement.

6. Add mock support.
   - Extend `LLMClient.mock()` with `speeches` and `transcriptions` queues.

7. Add docs.
   - Add `docs/SPEECH.md`.
   - Update `README.md`, `docs/README.md`, `docs/PROVIDER_COMPARISON.md`, and `docs/PRODUCTION_SETUP.md`.
   - Make unsupported Anthropic behavior explicit.

8. Add tests.
   - Provider mock tests.
   - Type-level tests if the project has them.
   - Optional live tests behind `LIVE_TESTS=1`.

## Main Issues We May Hit

- Bundle size growth from multipart and binary helpers, especially if adding file-type libraries. Prefer platform APIs and tiny local helpers.
- Provider mismatch: Gemini transcription can hallucinate or format text differently because it is generative audio understanding.
- Timestamps and diarization are not portable across providers.
- Realtime users may expect low-latency voice, but batch STT plus LLM plus TTS is not the same as a realtime audio model.
- Costs can be harder to estimate because usage may be token-based, duration-based, or absent depending on provider/model.
- Audio data retention and privacy requirements are stronger than ordinary text chats.
- Edge runtime support can break if implementation assumes Node `Buffer` or filesystem APIs.

## Recommendation

Add speech, but keep it narrow and explicit:

- v1: `client.transcribe()` and `client.speak()`.
- v1 providers: OpenAI full support, Gemini limited support, Anthropic unsupported with clear errors.
- v1 defaults: `gpt-4o-mini-transcribe` for STT and `gpt-4o-mini-tts` for TTS.
- Keep audio storage, recording consent, transcript retention, and realtime voice orchestration in the application layer.

This matches the architecture already used for embeddings: a stateless provider-agnostic verb for the model capability, with app-owned orchestration around it.

## Sources

- OpenAI Audio API reference, speech endpoint: https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
- OpenAI Audio API reference, transcription endpoint: https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- OpenAI `gpt-4o-transcribe` model page: https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- OpenAI `gpt-4o-mini-transcribe` model page: https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe
- OpenAI `gpt-4o-mini-tts` model page: https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- OpenAI realtime architecture guide: https://developers.openai.com/api/docs/guides/realtime#understand-different-architectures
- OpenAI `gpt-realtime-whisper` model page: https://developers.openai.com/api/docs/models/gpt-realtime-whisper
- Gemini speech generation docs: https://ai.google.dev/gemini-api/docs/speech-generation
- Gemini audio understanding docs: https://ai.google.dev/gemini-api/docs/audio
- Google Cloud Gemini-TTS docs: https://cloud.google.com/text-to-speech/docs/gemini-tts
- Anthropic API overview: https://platform.claude.com/docs/en/api/overview
- Anthropic models overview: https://platform.claude.com/docs/en/about-claude/models/overview
