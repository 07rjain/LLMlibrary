# Speech

`unified-llm-client` exposes speech as two explicit batch APIs:

- `client.speak()` for text-to-speech.
- `client.transcribe()` for speech-to-text.

Speech is intentionally separate from `complete()`, `stream()`, and `conversation()`. Text generation returns canonical text/tool responses, while speech uses binary audio, multipart uploads, duration-based billing, and different safety/storage expectations.

## Provider Support

The first implementation supports OpenAI batch speech endpoints.

| Provider | Text To Speech | Speech To Text | Notes |
|---|---:|---:|---|
| OpenAI | Yes | Yes | Uses `/v1/audio/speech` and `/v1/audio/transcriptions`. |
| Google Gemini | No | No | Planned later; Gemini speech uses different generation semantics. |
| Anthropic | No | No | Anthropic does not expose first-party TTS/STT endpoints through this library. |
| Mock | Yes | Yes | Use `LLMClient.mock()` for deterministic tests. |

Unsupported providers throw `ProviderCapabilityError` instead of silently falling back.

## Text To Speech

```ts
import { LLMClient } from 'unified-llm-client';

const client = LLMClient.fromEnv();

const speech = await client.speak({
  input: 'Your appointment is confirmed for 10 AM.',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  format: 'mp3',
  instructions: 'Use a calm support-agent tone.',
  estimatedOutputSeconds: 4,
});

console.log(speech.audio); // Uint8Array
console.log(speech.mediaType); // audio/mpeg
console.log(speech.usage?.costUSD); // number for arithmetic
console.log(speech.usage?.cost); // display string only
```

The library returns audio bytes. It does not write files or store audio for you.

## Speech To Text

```ts
const transcript = await client.transcribe({
  input: {
    data: audioBase64,
    filename: 'call.wav',
    mediaType: 'audio/wav',
  },
  inputAudioSeconds: 42,
  language: 'en',
  model: 'gpt-4o-mini-transcribe',
  responseFormat: 'json',
});

console.log(transcript.text);
console.log(transcript.durationSeconds);
console.log(transcript.usage?.costUSD);
```

`input` accepts `data` as base64, `file` as `Blob`, `ArrayBuffer`, or `Uint8Array`, or `url` when the runtime can fetch the file.

## Cost And Budgets

Speech usage uses `SpeechUsageMetrics`, not the text-generation `UsageMetrics` shape. Speech may be billed by text tokens, audio seconds, audio tokens, characters, or request count depending on the model.

Use:

- `usage.costUSD` for billing, limits, and persistence.
- `usage.cost` only for display.
- `usage.costBreakdown` when you need to show which units were estimated.

For budget preflight, duration-priced calls need enough information before the request is sent:

- `client.speak()` should pass `estimatedOutputSeconds` or `maxOutputSeconds` when output audio duration affects cost.
- `client.transcribe()` should pass `inputAudioSeconds` when the source duration cannot be derived from the audio bytes.

## Usage Logging

`PostgresUsageLogger` keeps speech usage separate from text completions. The default text table remains unchanged, and speech events are written to a sibling table named `${tableName}_speech`, for example:

```txt
llm_usage_events
llm_usage_events_speech
```

Query speech usage separately:

```ts
const summary = await client.getSpeechUsage({
  kind: 'speech',
  tenantId: 'tenant-1',
});

const csv = await client.exportSpeechUsage('csv', {
  tenantId: 'tenant-1',
});
```

This avoids mixing seconds, characters, and token counts into the normal `client.getUsage()` totals.

## Mocking

```ts
const client = LLMClient.mock({
  speeches: [
    {
      audio: new Uint8Array([1, 2, 3]),
      format: 'mp3',
      mediaType: 'audio/mpeg',
      model: 'mock-speech-model',
      provider: 'mock',
      raw: { mock: true },
    },
  ],
  transcriptions: [
    {
      text: 'hello world',
      model: 'mock-transcription-model',
      provider: 'mock',
      raw: { mock: true },
    },
  ],
});
```

## Production Notes

Do not log raw audio, base64 audio, or full transcripts by default. If you need storage, keep it in your application layer with your own retention, encryption, and consent policy. The library only returns bytes, transcript text, metadata, and usage.
