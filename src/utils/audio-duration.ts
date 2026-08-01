import type { AudioInput, SpeechOutputFormat } from '../types.js';

export function base64ToBytes(data: string): Uint8Array {
  const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function deriveAudioDurationSeconds(
  audio: Uint8Array,
  format: SpeechOutputFormat,
): number | undefined {
  if (format === 'pcm') {
    return audio.length / (24_000 * 2);
  }

  if (format !== 'wav') {
    return undefined;
  }

  return deriveWavDurationSeconds(audio);
}

export function deriveAudioInputDurationSeconds(
  input: AudioInput,
): number | undefined {
  const bytes =
    input.file instanceof Uint8Array
      ? input.file
      : input.file instanceof ArrayBuffer
        ? new Uint8Array(input.file)
        : input.data !== undefined
          ? base64ToBytes(input.data)
          : undefined;

  if (!bytes || !/wav|x-wav/i.test(input.mediaType)) {
    return undefined;
  }

  return deriveWavDurationSeconds(bytes);
}

export function mediaTypeForSpeechFormat(format: SpeechOutputFormat): string {
  switch (format) {
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'opus':
      return 'audio/opus';
    case 'pcm':
      return 'audio/pcm';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
    default:
      return 'audio/mpeg';
  }
}

function deriveWavDurationSeconds(audio: Uint8Array): number | undefined {
  if (
    audio.length < 44 ||
    textDecoder.decode(audio.subarray(0, 4)) !== 'RIFF'
  ) {
    return undefined;
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const byteRate = view.getUint32(28, true);
  const dataSize = findWavDataSize(audio);
  if (!byteRate || dataSize === undefined) {
    return undefined;
  }

  return dataSize / byteRate;
}

const textDecoder = new TextDecoder();

function findWavDataSize(audio: Uint8Array): number | undefined {
  for (let offset = 12; offset + 8 <= audio.length; ) {
    const chunkId = textDecoder.decode(audio.subarray(offset, offset + 4));
    const chunkSize = new DataView(
      audio.buffer,
      audio.byteOffset + offset + 4,
      4,
    ).getUint32(0, true);
    if (chunkId === 'data') {
      return chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return undefined;
}
