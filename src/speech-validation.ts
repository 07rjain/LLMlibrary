import { validateBudgetUsd } from './budget-validation.js';
import {
  hasValue,
  inspectArray,
  inspectRecord,
  invalid,
  readValue,
} from './validation-helpers.js';

import type { ValidationContext } from './validation-helpers.js';
import type {
  AudioInput,
  SpeechRequestOptions,
  TranscriptionRequestOptions,
} from './types.js';

const VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'cedar',
  'coral',
  'echo',
  'fable',
  'marin',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
]);
const FORMATS = ['aac', 'flac', 'mp3', 'opus', 'pcm', 'wav'];
const RESPONSE_FORMATS = [
  'diarized_json',
  'json',
  'srt',
  'text',
  'verbose_json',
  'vtt',
];
const MEDIA_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/webm',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
  'video/mp4',
  'video/webm',
]);
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SPEECH_FIELDS = [
  'botId',
  'budgetExceededAction',
  'budgetUsd',
  'estimatedOutputSeconds',
  'format',
  'input',
  'instructions',
  'maxOutputSeconds',
  'model',
  'provider',
  'providerOptions',
  'sessionId',
  'signal',
  'speed',
  'tenantId',
  'voice',
] as const;
const TRANSCRIPTION_FIELDS = [
  'botId',
  'budgetExceededAction',
  'budgetUsd',
  'diarization',
  'input',
  'inputAudioSeconds',
  'language',
  'model',
  'prompt',
  'provider',
  'providerOptions',
  'responseFormat',
  'sessionId',
  'signal',
  'temperature',
  'tenantId',
  'timestampGranularities',
  'transcriptionUrlPolicy',
] as const;

export function validateSpeechRequest<T extends SpeechRequestOptions>(
  options: T,
): T {
  const context = speechContext(
    'invalid_speech',
    'Invalid text-to-speech request.',
  );
  const safe = requestSnapshot(options, context, SPEECH_FIELDS);
  validateBudgetUsd(safe.budgetUsd);
  if (
    typeof safe.input !== 'string' ||
    !safe.input.trim() ||
    safe.input.length > 4096
  ) {
    invalid(context, 'non_empty_string_max_4096', { path: 'input' });
  }
  if (safe.format !== undefined && !FORMATS.includes(safe.format)) {
    invalid(context, 'supported_audio_format', { path: 'format' });
  }
  number(safe.speed, context, 'speed', 0.25, 4);
  number(safe.estimatedOutputSeconds, context, 'estimatedOutputSeconds');
  number(safe.maxOutputSeconds, context, 'maxOutputSeconds');
  if (
    safe.instructions !== undefined &&
    typeof safe.instructions !== 'string'
  ) {
    invalid(context, 'string', { path: 'instructions' });
  }
  if (typeof safe.voice === 'string') {
    if (!VOICES.has(safe.voice)) {
      invalid(context, 'built_in_voice_or_custom_id', { path: 'voice' });
    }
  } else if (safe.voice !== undefined) {
    const d = inspectRecord(safe.voice, context, 'voice', ['id']);
    const id = readValue(d, 'id');
    if (typeof id !== 'string' || !id.trim()) {
      invalid(context, 'non_empty_string', { path: 'voice.id' });
    }
    return { ...safe, voice: { id } } as T;
  }
  return safe as T;
}

export function validateTranscriptionRequest<
  T extends TranscriptionRequestOptions,
>(options: T): T {
  const context = speechContext(
    'invalid_transcription',
    'Invalid transcription request.',
  );
  const safe = requestSnapshot(options, context, TRANSCRIPTION_FIELDS);
  validateBudgetUsd(safe.budgetUsd);
  const input = audioInput(safe.input, context);
  number(safe.inputAudioSeconds, context, 'inputAudioSeconds');
  if (
    safe.responseFormat !== undefined &&
    !RESPONSE_FORMATS.includes(safe.responseFormat)
  ) {
    invalid(context, 'supported_response_format', { path: 'responseFormat' });
  }
  number(safe.temperature, context, 'temperature', 0, 1);
  if (safe.timestampGranularities === undefined) {
    return { ...safe, input } as T;
  }
  const timestamps = inspectArray(
    safe.timestampGranularities,
    context,
    'timestampGranularities',
  ).map((item, index) => {
    if (item.value !== 'segment' && item.value !== 'word') {
      invalid(context, 'supported_timestamp_granularity', {
        path: `timestampGranularities[${index}]`,
      });
    }
    return item.value;
  });
  if (safe.responseFormat !== 'verbose_json') {
    invalid(context, 'verbose_json_timestamp_format', {
      path: 'timestampGranularities',
    });
  }
  return { ...safe, input, timestampGranularities: timestamps } as T;
}

function requestSnapshot<T extends object>(
  value: T,
  context: ValidationContext,
  fields: readonly string[],
): T {
  return Object.fromEntries(
    Object.entries(inspectRecord(value, context, 'request', fields)).map(
      ([key, descriptor]) => [key, descriptor.value],
    ),
  ) as T;
}

function audioInput(value: unknown, context: ValidationContext): AudioInput {
  const d = inspectRecord(value, context, 'input', [
    'data',
    'file',
    'filename',
    'mediaType',
    'url',
  ]);
  const mediaType = readValue(d, 'mediaType');
  const filename = readValue(d, 'filename');
  const type =
    typeof mediaType === 'string'
      ? mediaType.split(';', 1)[0]!.trim().toLowerCase()
      : '';
  if (!MEDIA_TYPES.has(type)) {
    invalid(context, 'supported_audio_media_type', { path: 'input.mediaType' });
  }
  if (
    hasValue(d, 'filename') &&
    (typeof filename !== 'string' || !filename.trim())
  ) {
    invalid(context, 'non_empty_string', { path: 'input.filename' });
  }
  const sources = ['data', 'file', 'url'].filter((key) => hasValue(d, key));
  if (sources.length !== 1) {
    invalid(context, 'exactly_one_audio_source', { path: 'input' });
  }
  const source = sources[0]!;
  const item = readValue(d, source);
  if (source === 'data' && !validData(item, type)) {
    invalid(context, 'non_empty_base64_or_data_url', { path: 'input.data' });
  }
  if (source === 'file' && !validFile(item)) {
    invalid(context, 'non_empty_binary', { path: 'input.file' });
  }
  if (source === 'url' && !validUrl(item)) {
    invalid(
      {
        ...context,
        message: 'Transcription audio input must use a valid URL.',
      },
      'absolute_url',
      { path: 'input.url' },
    );
  }
  return {
    ...(source === 'data' ? { data: item as string } : {}),
    ...(source === 'file'
      ? { file: item as ArrayBuffer | Blob | Uint8Array }
      : {}),
    ...(typeof filename === 'string' ? { filename } : {}),
    mediaType: mediaType as string,
    ...(source === 'url' ? { url: item as string } : {}),
  };
}

function number(
  value: unknown,
  context: ValidationContext,
  path: string,
  minimum = 0,
  maximum = Number.POSITIVE_INFINITY,
): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum)
  ) {
    invalid(context, 'finite_number_range', { path });
  }
}

function validData(value: unknown, type: string): boolean {
  if (typeof value !== 'string' || !value) return false;
  if (!value.startsWith('data:'))
    return value.length % 4 === 0 && BASE64.test(value);
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
  return Boolean(
    match &&
    match[1]!.toLowerCase() === type &&
    match[2]!.length % 4 === 0 &&
    BASE64.test(match[2]!),
  );
}

function validFile(value: unknown): boolean {
  return (
    (value instanceof Uint8Array && value.byteLength > 0) ||
    (value instanceof ArrayBuffer && value.byteLength > 0) ||
    (typeof Blob !== 'undefined' && value instanceof Blob && value.size > 0)
  );
}

function validUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.hostname);
  } catch {
    return false;
  }
}

function speechContext(code: string, message: string): ValidationContext {
  return { code, message, option: 'speech' };
}
