# Speech

`unified-llm-client` exposes speech as two explicit batch APIs:

- `client.speak()` for text-to-speech.
- `client.transcribe()` for speech-to-text.

Speech is intentionally separate from `complete()`, `stream()`, and `conversation()`. Text generation returns canonical text/tool responses, while speech uses binary audio, multipart uploads, duration-based billing, and different safety/storage expectations.

## Provider Support

The first implementation supports OpenAI batch speech endpoints.

| Provider      | Text To Speech | Speech To Text | Notes                                                                         |
| ------------- | -------------: | -------------: | ----------------------------------------------------------------------------- |
| OpenAI        |            Yes |            Yes | Uses `/v1/audio/speech` and `/v1/audio/transcriptions`.                       |
| Google Gemini |             No |             No | Planned later; Gemini speech uses different generation semantics.             |
| Anthropic     |             No |             No | Anthropic does not expose first-party TTS/STT endpoints through this library. |
| Mock          |            Yes |            Yes | Use `LLMClient.mock()` for deterministic tests.                               |

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

TTS preflight rejects invalid requests before provider or mock dispatch:

- `input` must contain non-whitespace text and is limited to 4096 JavaScript
  characters
- `format` is one of `mp3`, `opus`, `aac`, `flac`, `wav`, or `pcm`
- `speed` is a finite number from `0.25` through `4`
- a voice is a documented built-in name or a plain `{ id: string }` custom
  voice
- duration estimates are finite non-negative numbers; fractional seconds are
  valid

The top-level request must be a plain object containing only documented
enumerable data fields. Unknown fields and accessors are rejected without
invoking getters.

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

`input` accepts `data` as base64 or `file` as `Blob`, `ArrayBuffer`, or `Uint8Array`.

Exactly one non-empty source is required: `data`, `file`, or `url`.
`mediaType` must identify a supported audio/container format. Base64 is parsed
strictly, binary values must not be empty, filenames must be non-empty when
present, and URL strings must be absolute before the separate URL/SSRF policy
runs. Response formats, temperatures, and timestamp granularities are also
validated locally. Invalid requests consume no mock response and perform no
fetch or usage log.

The same exact-field, accessor-free top-level object rule applies to
transcription requests.

`input.url` is disabled by default because the library runtime would fetch that URL server-side. To enable URL input, pass an explicit `transcriptionUrlPolicy` with allowed protocols/hosts, byte limits, redirect limits, and a `resolveHostname` function when private-network blocking is enabled. The adapter validates every redirect hop and streams the response with `maxBytes` enforcement.

## Cost And Budgets

Speech usage uses `SpeechUsageMetrics`, not the text-generation `UsageMetrics` shape. Speech may be billed by text tokens, audio seconds, audio tokens, characters, or request count depending on the model.

Use:

- `usage.costUSD` for billing, limits, and persistence.
- `usage.cost` only for display.
- `usage.costBreakdown` when you need to show which units were estimated.

For budget preflight, duration-priced calls need enough information before the request is sent:

- `client.speak()` uses `estimatedOutputSeconds` first and
  `maxOutputSeconds` as its fallback when output audio duration affects cost.
- `client.transcribe()` uses `inputAudioSeconds` first. Otherwise it derives
  duration locally from supported WAV `Uint8Array`, `ArrayBuffer`, or base64
  data. It never fetches a URL or calls a provider merely to estimate cost.
- If duration-based pricing applies and the required duration remains unknown,
  preflight fails closed with `BudgetExceededError` before dispatch.

`budgetExceededAction` has the same contract for speech and transcription:

- `throw` rejects before dispatch and emits no usage event.
- `warn` calls the configured warning callback once, dispatches once, and logs
  the successful speech usage event.
- `skip` does not fetch, consume a mock queue entry, or dispatch an adapter. It
  returns an empty operation-specific response and logs one estimated,
  zero-cost speech usage event so budget decisions remain auditable.

Speech and transcription events always use `UsageLogger.logSpeech()` with a
`kind` of `speech` or `transcription`; they are never added to text-generation
usage totals.

`budgetUsd`, `estimatedOutputSeconds`, `maxOutputSeconds`, and
`inputAudioSeconds` accept finite non-negative decimals. Negative values,
numeric strings, `NaN`, and infinities fail locally.

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

The reserved `mock-speech-model` and `mock-transcription-model` entries include
default non-zero speech pricing so budget actions exercise the same preflight
path as provider-backed clients. When a custom registry defines either reserved
model, missing default price units are merged while explicit custom prices win.
Other custom model IDs are never assigned implicit speech prices.

## Production Notes

Do not log raw audio, base64 audio, or full transcripts by default. If you need storage, keep it in your application layer with your own retention, encryption, and consent policy. The library only returns bytes, transcript text, metadata, and usage.
