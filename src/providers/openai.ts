import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import {
  openaiUsageToCanonical,
  speechUsageWithCost,
  usageWithCost,
} from '../utils/cost.js';
import { parseSSE } from '../utils/parse-sse.js';
import { withRetry } from '../utils/retry.js';
import { estimateTokens } from '../utils/token-estimator.js';
import { buildOpenAITextFormat } from '../structured-output.js';

import type {
  AudioInput,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalPart,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
  JsonObject,
  JsonValue,
  ProviderOptions,
  RemoteModelInfo,
  ResponseFormat,
  SpeechRequestOptions,
  SpeechResponse,
  StreamChunk,
  TranscriptionRequestOptions,
  TranscriptionResponse,
  TranscriptionSegment,
  TranscriptionUrlPolicy,
  TranscriptionWord,
} from '../types.js';
import type { OpenAIUsagePayload } from '../utils/cost.js';
import type { RetryOptions } from '../utils/retry.js';

type OpenAIInputItem =
  | OpenAIFunctionCallInput
  | OpenAIFunctionCallOutputInput
  | OpenAIMessageInput;

interface OpenAIInputTextPart {
  text: string;
  type: 'input_text';
}

interface OpenAIInputImagePart {
  detail?: 'auto' | 'high' | 'low';
  image_url: string;
  type: 'input_image';
}

type OpenAIInputContentPart = OpenAIInputImagePart | OpenAIInputTextPart;

interface OpenAIMessageInput {
  content: OpenAIInputContentPart[];
  role: 'assistant' | 'user';
  type: 'message';
}

interface OpenAIFunctionCallInput {
  arguments: string;
  call_id: string;
  id?: string;
  name: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'function_call';
}

interface OpenAIFunctionCallOutputInput {
  call_id: string;
  id?: string;
  output: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'function_call_output';
}

interface OpenAIToolDefinition {
  description: string;
  name: string;
  parameters: CanonicalTool['parameters'];
  strict: false;
  type: 'function';
}

type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { name: string; type: 'function' };

interface OpenAIResponseErrorPayload {
  code?: string | null;
  message?: string | null;
  param?: string | null;
  type?: string;
}

interface OpenAIOutputTextPart {
  annotations?: unknown[];
  text: string;
  type: 'output_text';
}

interface OpenAIRefusalPart {
  refusal: string;
  type: 'refusal';
}

type OpenAIOutputMessageContentPart =
  | OpenAIOutputTextPart
  | OpenAIRefusalPart
  | { type: string; [key: string]: unknown };

interface OpenAIMessageOutput {
  content: OpenAIOutputMessageContentPart[];
  id: string;
  role: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'message';
}

interface OpenAIFunctionCallOutput {
  arguments: string;
  call_id: string;
  id: string;
  name: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'function_call';
}

type OpenAIOutputItem =
  | OpenAIFunctionCallOutput
  | OpenAIMessageOutput
  | { id?: string; type: string; [key: string]: unknown };

interface OpenAIResponsePayload {
  created_at?: number;
  error?: OpenAIResponseErrorPayload | null;
  id: string;
  incomplete_details?: {
    reason?: string | null;
  } | null;
  model: string;
  object: 'response';
  output?: OpenAIOutputItem[];
  status: 'completed' | 'failed' | 'in_progress' | 'incomplete';
  usage?: OpenAIUsagePayload;
}

interface OpenAIErrorBody {
  error?: OpenAIResponseErrorPayload;
}

interface OpenAIModelPayload {
  created?: number;
  id: string;
  object: string;
  owned_by?: string;
}

interface OpenAIModelListPayload {
  data?: OpenAIModelPayload[];
  object?: string;
}

interface OpenAIResponseOutputTextDeltaEvent {
  content_index: number;
  delta: string;
  item_id: string;
  output_index: number;
  sequence_number: number;
  type: 'response.output_text.delta';
}

interface OpenAIResponseOutputItemAddedEvent {
  item: OpenAIOutputItem;
  output_index: number;
  sequence_number: number;
  type: 'response.output_item.added';
}

interface OpenAIResponseOutputItemDoneEvent {
  item: OpenAIOutputItem;
  output_index: number;
  sequence_number: number;
  type: 'response.output_item.done';
}

interface OpenAIResponseFunctionCallArgumentsDeltaEvent {
  delta: string;
  item_id: string;
  output_index: number;
  sequence_number: number;
  type: 'response.function_call_arguments.delta';
}

interface OpenAIResponseFunctionCallArgumentsDoneEvent {
  arguments: string;
  call_id?: string;
  item_id: string;
  name: string;
  output_index: number;
  sequence_number: number;
  type: 'response.function_call_arguments.done';
}

interface OpenAIResponseCompletedEvent {
  response: OpenAIResponsePayload;
  sequence_number: number;
  type: 'response.completed';
}

interface OpenAIResponseFailedEvent {
  response: OpenAIResponsePayload;
  sequence_number: number;
  type: 'response.failed';
}

interface OpenAIResponseIncompleteEvent {
  response: OpenAIResponsePayload;
  sequence_number: number;
  type: 'response.incomplete';
}

interface OpenAIResponseErrorEvent {
  code?: string | null;
  message?: string;
  param?: string | null;
  type: 'error';
}

export interface OpenAIClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  modelRegistry?: ModelRegistry;
  organization?: string;
  project?: string;
  retryOptions?: RetryOptions;
}

export interface OpenAICompletionOptions {
  maxTokens?: number;
  messages: CanonicalMessage[];
  model: string;
  providerOptions?: ProviderOptions;
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  system?: string;
  temperature?: number;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

export interface OpenAIAdapterSpeechOptions extends SpeechRequestOptions {
  model: string;
  provider: 'openai';
}

export interface OpenAIAdapterTranscriptionOptions
  extends TranscriptionRequestOptions {
  model: string;
  provider: 'openai';
}

export class OpenAIAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly modelRegistry: ModelRegistry;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;
  private readonly retryOptions: RetryOptions | undefined;

  constructor(config: OpenAIClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
    this.organization = config.organization;
    this.project = config.project;
    this.retryOptions = config.retryOptions;
  }

  async complete(options: OpenAICompletionOptions): Promise<CanonicalResponse> {
    this.assertCapabilities(options);

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/responses`,
          buildRequestInit(
            {
              body: JSON.stringify(translateOpenAIRequest(options)),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapOpenAIError(response, options.model);
    }

    const payload = (await response.json()) as OpenAIResponsePayload;
    return translateOpenAIResponse(payload, this.modelRegistry, options.model);
  }

  async *stream(
    options: OpenAICompletionOptions,
  ): AsyncGenerator<StreamChunk, void, void> {
    this.assertCapabilities({ ...options, stream: true });

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/responses`,
          buildRequestInit(
            {
              body: JSON.stringify({
                ...translateOpenAIRequest(options),
                stream: true,
              }),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapOpenAIError(response, options.model);
    }

    if (!response.body) {
      throw new ProviderError('OpenAI streaming response did not include a body.', {
        model: options.model,
        provider: 'openai',
      });
    }

    const assembler = new OpenAIStreamAssembler(options.model, this.modelRegistry);
    for await (const payload of parseSSE(response.body)) {
      const event = JSON.parse(payload) as { [key: string]: unknown; type?: string };
      yield* assembler.consume(event);
    }

    yield assembler.finish();
  }

  async listModels(): Promise<RemoteModelInfo[]> {
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/models`,
          buildRequestInit(
            {
              headers: this.buildHeaders(),
              method: 'GET',
            },
            undefined,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapOpenAIError(response);
    }

    const payload = (await response.json()) as OpenAIModelListPayload;
    return (payload.data ?? []).map((model) => {
      const createdAt = normalizeUnixTimestamp(model.created);
      return {
        ...(createdAt ? { createdAt } : {}),
        displayName: model.id,
        id: model.id,
        ...(model.owned_by ? { ownedBy: model.owned_by } : {}),
        provider: 'openai',
        raw: model,
      };
    });
  }

  async speak(options: OpenAIAdapterSpeechOptions): Promise<SpeechResponse> {
    const format = options.format ?? 'mp3';
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/audio/speech`,
          buildRequestInit(
            {
              body: JSON.stringify(translateOpenAISpeechRequest(options, format)),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapOpenAIError(response, options.model);
    }

    const audio = new Uint8Array(await response.arrayBuffer());
    const model = this.modelRegistry.get(options.model);
    const outputAudioSeconds =
      options.estimatedOutputSeconds ??
      deriveAudioDurationSeconds(audio, format) ??
      options.maxOutputSeconds;
    const usage = speechUsageWithCost(model, {
      estimated: true,
      inputCharacters: options.input.length,
      inputTokens: estimateTokens(options.input),
      ...(outputAudioSeconds !== undefined ? { outputAudioSeconds } : {}),
    });

    return {
      audio,
      format,
      mediaType: response.headers.get('content-type') ?? mediaTypeForSpeechFormat(format),
      model: options.model,
      provider: 'openai',
      raw: {
        headers: Object.fromEntries(response.headers.entries()),
      },
      usage,
    };
  }

  async transcribe(
    options: OpenAIAdapterTranscriptionOptions,
  ): Promise<TranscriptionResponse> {
    const body = await buildOpenAITranscriptionFormData(options, this.fetchImplementation);
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/audio/transcriptions`,
          buildRequestInit(
            {
              body,
              headers: this.buildHeaders({ contentType: false }),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapOpenAIError(response, options.model);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const raw =
      contentType.includes('application/json') || contentType.includes('+json')
        ? ((await response.json()) as OpenAITranscriptionPayload)
        : await response.text();
    const normalized = normalizeOpenAITranscription(raw);
    const model = this.modelRegistry.get(options.model);
    const inputAudioSeconds =
      options.inputAudioSeconds ?? deriveAudioInputDurationSeconds(options.input);
    const usage = speechUsageWithCost(model, {
      estimated: true,
      ...(inputAudioSeconds !== undefined ? { inputAudioSeconds } : {}),
      outputCharacters: normalized.text.length,
      outputTokens: estimateTokens(normalized.text),
    });

    return {
      ...normalized,
      ...(inputAudioSeconds !== undefined && normalized.durationSeconds === undefined
        ? { durationSeconds: inputAudioSeconds }
        : {}),
      model: options.model,
      provider: 'openai',
      raw,
      usage,
    };
  }

  private assertCapabilities(
    options: OpenAICompletionOptions & { stream?: boolean },
  ): void {
    if (options.tools && options.tools.length > 0) {
      this.modelRegistry.assertCapability(options.model, 'supportsTools', 'tool calling');
    }

    if (options.stream) {
      this.modelRegistry.assertCapability(options.model, 'supportsStreaming', 'streaming');
    }

    if (options.messages.some(messageContainsVisionContent)) {
      this.modelRegistry.assertCapability(options.model, 'supportsVision', 'vision');
    }

    if (options.messages.some(messageContainsUnsupportedOpenAIParts)) {
      throw new ProviderCapabilityError(
        `Model "${options.model}" request includes unsupported content parts for the OpenAI Responses API.`,
        {
          model: options.model,
          provider: 'openai',
        },
      );
    }
  }

  private buildHeaders(
    options: { contentType?: false | string } = {},
  ): Record<string, string> {
    const contentType =
      options.contentType === false
        ? {}
        : { 'Content-Type': options.contentType ?? 'application/json' };
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...contentType,
      ...(this.organization ? { 'OpenAI-Organization': this.organization } : {}),
      ...(this.project ? { 'OpenAI-Project': this.project } : {}),
    };
  }
}

interface OpenAITranscriptionPayload {
  duration?: number;
  language?: string;
  segments?: TranscriptionSegment[];
  text?: string;
  words?: TranscriptionWord[];
  [key: string]: unknown;
}

function translateOpenAISpeechRequest(
  options: OpenAIAdapterSpeechOptions,
  format: string,
): Record<string, unknown> {
  return {
    input: options.input,
    model: options.model,
    response_format: format,
    voice: options.voice ?? 'alloy',
    ...(options.instructions !== undefined
      ? { instructions: options.instructions }
      : {}),
    ...(options.speed !== undefined ? { speed: options.speed } : {}),
  };
}

async function buildOpenAITranscriptionFormData(
  options: OpenAIAdapterTranscriptionOptions,
  fetchImplementation: typeof fetch,
): Promise<FormData> {
  const formData = new FormData();
  formData.set(
    'file',
    await audioInputToBlob(
      options.input,
      options.transcriptionUrlPolicy,
      fetchImplementation,
      options.signal,
    ),
    options.input.filename ?? 'audio',
  );
  formData.set('model', options.model);

  if (options.language !== undefined) {
    formData.set('language', options.language);
  }

  if (options.prompt !== undefined) {
    formData.set('prompt', options.prompt);
  }

  const responseFormat =
    options.responseFormat ??
    (options.diarization || options.model === 'gpt-4o-transcribe-diarize'
      ? 'diarized_json'
      : undefined);
  if (responseFormat !== undefined) {
    formData.set('response_format', responseFormat);
  }

  if (options.temperature !== undefined) {
    formData.set('temperature', String(options.temperature));
  }

  for (const granularity of options.timestampGranularities ?? []) {
    formData.append('timestamp_granularities[]', granularity);
  }

  const openaiOptions = options.providerOptions?.openai;
  if (openaiOptions?.chunkingStrategy !== undefined) {
    formData.set(
      'chunking_strategy',
      typeof openaiOptions.chunkingStrategy === 'string'
        ? openaiOptions.chunkingStrategy
        : JSON.stringify(openaiOptions.chunkingStrategy),
    );
  } else if (options.diarization || options.model === 'gpt-4o-transcribe-diarize') {
    formData.set('chunking_strategy', 'auto');
  }

  for (const include of openaiOptions?.include ?? []) {
    formData.append('include[]', include);
  }

  for (const name of openaiOptions?.knownSpeakerNames ?? []) {
    formData.append('known_speaker_names[]', name);
  }

  for (const reference of openaiOptions?.knownSpeakerReferences ?? []) {
    formData.append('known_speaker_references[]', reference);
  }

  return formData;
}

async function audioInputToBlob(
  input: AudioInput,
  urlPolicy: TranscriptionUrlPolicy | undefined,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  if (input.file instanceof Blob) {
    return input.file;
  }

  if (input.file instanceof ArrayBuffer) {
    return new Blob([input.file], { type: input.mediaType });
  }

  if (input.file instanceof Uint8Array) {
    return new Blob([bytesToArrayBuffer(input.file)], { type: input.mediaType });
  }

  if (input.data !== undefined) {
    return new Blob([bytesToArrayBuffer(base64ToBytes(input.data))], {
      type: input.mediaType,
    });
  }

  if (input.url !== undefined) {
    return fetchTranscriptionAudioUrl(input.url, input.mediaType, urlPolicy, fetchImplementation, signal);
  }

  throw new ProviderCapabilityError(
    'Transcription audio input requires file, data, or url.',
    {
      provider: 'openai',
    },
  );
}

const DEFAULT_TRANSCRIPTION_URL_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TRANSCRIPTION_URL_MAX_REDIRECTS = 3;
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [ipv4ToNumber('0.0.0.0'), ipv4ToNumber('0.255.255.255')],
  [ipv4ToNumber('10.0.0.0'), ipv4ToNumber('10.255.255.255')],
  [ipv4ToNumber('100.64.0.0'), ipv4ToNumber('100.127.255.255')],
  [ipv4ToNumber('127.0.0.0'), ipv4ToNumber('127.255.255.255')],
  [ipv4ToNumber('169.254.0.0'), ipv4ToNumber('169.254.255.255')],
  [ipv4ToNumber('172.16.0.0'), ipv4ToNumber('172.31.255.255')],
  [ipv4ToNumber('192.0.0.0'), ipv4ToNumber('192.0.0.255')],
  [ipv4ToNumber('192.168.0.0'), ipv4ToNumber('192.168.255.255')],
  [ipv4ToNumber('198.18.0.0'), ipv4ToNumber('198.19.255.255')],
  [ipv4ToNumber('224.0.0.0'), ipv4ToNumber('255.255.255.255')],
];

async function fetchTranscriptionAudioUrl(
  url: string,
  fallbackMediaType: string,
  policy: TranscriptionUrlPolicy | undefined,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  if (!policy?.enabled) {
    throw new ProviderCapabilityError(
      'Transcription audio URL input is disabled by default. Pass file/data input or enable transcriptionUrlPolicy.',
      {
        provider: 'openai',
      },
    );
  }

  let currentUrl = parseTranscriptionUrl(url);
  const maxRedirects = policy.maxRedirects ?? DEFAULT_TRANSCRIPTION_URL_MAX_REDIRECTS;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertAllowedTranscriptionUrl(currentUrl, policy);
    const response = await fetchImplementation(currentUrl.toString(), {
      redirect: 'manual',
      ...(signal !== undefined ? { signal } : {}),
    });

    if (isRedirectResponse(response)) {
      if (redirectCount === maxRedirects) {
        throw new ProviderError('Transcription audio URL exceeded redirect limit.', {
          provider: 'openai',
          statusCode: response.status,
        });
      }

      const location = response.headers.get('location');
      if (!location) {
        throw new ProviderError('Transcription audio URL redirect did not include a location.', {
          provider: 'openai',
          statusCode: response.status,
        });
      }
      currentUrl = parseTranscriptionUrl(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new ProviderError(
        `Failed to fetch transcription audio URL with status ${response.status}.`,
        {
          provider: 'openai',
          statusCode: response.status,
        },
      );
    }

    const mediaType = response.headers.get('content-type') ?? fallbackMediaType;
    assertAllowedTranscriptionContentType(mediaType, policy);
    const bytes = await readResponseBodyWithLimit(
      response,
      policy.maxBytes ?? DEFAULT_TRANSCRIPTION_URL_MAX_BYTES,
    );
    return new Blob([bytesToArrayBuffer(bytes)], { type: mediaType });
  }

  throw new ProviderError('Transcription audio URL exceeded redirect limit.', {
    provider: 'openai',
  });
}

function parseTranscriptionUrl(url: string, base?: URL): URL {
  try {
    return new URL(url, base);
  } catch {
    throw new ProviderCapabilityError('Transcription audio URL must be a valid URL.', {
      provider: 'openai',
    });
  }
}

async function assertAllowedTranscriptionUrl(
  url: URL,
  policy: TranscriptionUrlPolicy,
): Promise<void> {
  const allowedProtocols = policy.allowedProtocols ?? ['https:'];
  if (!allowedProtocols.includes(url.protocol as 'http:' | 'https:')) {
    throw new ProviderCapabilityError(
      `Transcription audio URL protocol "${url.protocol}" is not allowed.`,
      {
        provider: 'openai',
      },
    );
  }

  const hostname = normalizeNetworkAddress(url.hostname);
  if (
    policy.allowedHosts &&
    !policy.allowedHosts.map(normalizeNetworkAddress).includes(hostname)
  ) {
    throw new ProviderCapabilityError(
      `Transcription audio URL host "${hostname}" is not allowed.`,
      {
        provider: 'openai',
      },
    );
  }

  if (policy.blockPrivateNetworks ?? true) {
    const addresses = await resolveTranscriptionUrlAddresses(hostname, policy);
    if (addresses.some(isPrivateOrLocalAddress)) {
      throw new ProviderCapabilityError(
        'Transcription audio URL resolves to a private or local network address.',
        {
          provider: 'openai',
        },
      );
    }
  }
}

async function resolveTranscriptionUrlAddresses(
  hostname: string,
  policy: TranscriptionUrlPolicy,
): Promise<string[]> {
  if (isIpAddress(hostname)) {
    return [hostname];
  }

  if (isLocalHostname(hostname)) {
    return ['127.0.0.1'];
  }

  if (!policy.resolveHostname) {
    throw new ProviderCapabilityError(
      'Transcription URL policy requires resolveHostname when private network blocking is enabled for hostnames.',
      {
        provider: 'openai',
      },
    );
  }

  return policy.resolveHostname(hostname);
}

function assertAllowedTranscriptionContentType(
  contentType: string,
  policy: TranscriptionUrlPolicy,
): void {
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const allowed = policy.allowedContentTypes ?? ['audio/'];
  const isAllowed = allowed.some((item) => {
    const normalized = item.toLowerCase();
    return normalized.endsWith('/') ? mediaType.startsWith(normalized) : mediaType === normalized;
  });

  if (!isAllowed) {
    throw new ProviderCapabilityError(
      `Transcription audio URL returned disallowed content type "${mediaType}".`,
      {
        provider: 'openai',
      },
    );
  }
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new ProviderCapabilityError('transcriptionUrlPolicy.maxBytes must be a positive integer.', {
      provider: 'openai',
    });
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ProviderCapabilityError('Transcription audio URL response exceeded maxBytes.', {
        provider: 'openai',
      });
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new ProviderCapabilityError('Transcription audio URL response exceeded maxBytes.', {
        provider: 'openai',
      });
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function isIpAddress(value: string): boolean {
  const normalized = normalizeNetworkAddress(value);
  return isIpv4Address(normalized) || isIpv6Address(normalized);
}

function isIpv4Address(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every((part) => {
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function isIpv6Address(value: string): boolean {
  return value.includes(':');
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeNetworkAddress(hostname);
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

function isPrivateOrLocalAddress(address: string): boolean {
  const normalized = normalizeNetworkAddress(address);
  if (isIpv4Address(normalized)) {
    const numeric = ipv4ToNumber(normalized);
    return PRIVATE_IPV4_RANGES.some(([start, end]) => numeric >= start && numeric <= end);
  }

  const mappedIpv4 = ipv4MappedIpv6ToNumber(normalized);
  if (mappedIpv4 !== undefined) {
    return PRIVATE_IPV4_RANGES.some(([start, end]) => mappedIpv4 >= start && mappedIpv4 <= end);
  }

  if (!isIpv6Address(normalized)) {
    return true;
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff')
  );
}

function normalizeNetworkAddress(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

function ipv4MappedIpv6ToNumber(address: string): number | undefined {
  if (!address.startsWith('::ffff:')) {
    return undefined;
  }

  const suffix = address.slice('::ffff:'.length);
  if (isIpv4Address(suffix)) {
    return ipv4ToNumber(suffix);
  }

  const groups = suffix.split(':');
  if (groups.length === 0 || groups.length > 2) {
    return undefined;
  }

  const [high = '0', low = '0'] = groups;
  if (!isIpv6Hextet(high) || !isIpv6Hextet(low)) {
    return undefined;
  }

  return Number.parseInt(high, 16) * 65_536 + Number.parseInt(low, 16);
}

function isIpv6Hextet(value: string): boolean {
  return /^[0-9a-f]{1,4}$/i.test(value);
}

function ipv4ToNumber(address: string): number {
  return address
    .split('.')
    .reduce((total, octet) => total * 256 + Number(octet), 0);
}

function normalizeOpenAITranscription(
  raw: OpenAITranscriptionPayload | string,
): Omit<TranscriptionResponse, 'model' | 'provider' | 'raw' | 'usage'> {
  if (typeof raw === 'string') {
    return {
      text: raw,
    };
  }

  return {
    ...(typeof raw.duration === 'number' ? { durationSeconds: raw.duration } : {}),
    ...(typeof raw.language === 'string' ? { language: raw.language } : {}),
    ...(Array.isArray(raw.segments) ? { segments: raw.segments } : {}),
    text: typeof raw.text === 'string' ? raw.text : '',
    ...(Array.isArray(raw.words) ? { words: raw.words } : {}),
  };
}

function base64ToBytes(data: string): Uint8Array {
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

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function deriveAudioDurationSeconds(
  audio: Uint8Array,
  format: string,
): number | undefined {
  if (format === 'pcm') {
    return audio.length / (24_000 * 2);
  }

  if (format !== 'wav') {
    return undefined;
  }

  return deriveWavDurationSeconds(audio);
}

function deriveAudioInputDurationSeconds(input: AudioInput): number | undefined {
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

function deriveWavDurationSeconds(audio: Uint8Array): number | undefined {
  if (audio.length < 44 || textDecoder.decode(audio.subarray(0, 4)) !== 'RIFF') {
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

function mediaTypeForSpeechFormat(format: string): string {
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

export function translateOpenAIRequest(
  options: OpenAICompletionOptions,
): Record<string, unknown> {
  const input: OpenAIInputItem[] = [];
  const instructions: string[] = [];
  const openaiOptions = options.providerOptions?.openai;
  const promptCaching = openaiOptions?.promptCaching;
  const reasoning = openaiOptions?.reasoning;

  if (options.system) {
    instructions.push(options.system);
  }

  for (const message of options.messages) {
    if (message.role === 'system') {
      instructions.push(translateOpenAISystemMessage(message));
      continue;
    }

    input.push(...translateOpenAIMessage(message));
  }

  const body: Record<string, unknown> = {
    input,
    model: options.model,
    store: false,
  };

  if (instructions.length > 0) {
    body.instructions = instructions.join('\n\n');
  }

  if (options.maxTokens !== undefined) {
    body.max_output_tokens = options.maxTokens;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  const textFormat = buildOpenAITextFormat(options.responseFormat, {
    messages: options.messages,
    ...(options.system !== undefined ? { system: options.system } : {}),
  });
  if (textFormat !== undefined) {
    body.text = textFormat;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(translateOpenAITool);
  }

  if (options.toolChoice) {
    const mappedChoice = translateOpenAIToolChoice(options.toolChoice);
    body.tool_choice = mappedChoice.toolChoice;
    if (mappedChoice.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = mappedChoice.parallelToolCalls;
    }
  }

  if (reasoning) {
    const reasoningBody: Record<string, unknown> = {};
    if (reasoning.effort !== undefined) {
      reasoningBody.effort = reasoning.effort;
    }
    if (reasoning.summary !== undefined) {
      reasoningBody.summary = reasoning.summary;
    }
    if (Object.keys(reasoningBody).length > 0) {
      body.reasoning = reasoningBody;
    }
    if (reasoning.includeEncryptedContent) {
      body.include = ['reasoning.encrypted_content'];
    }
  }

  if (promptCaching?.key) {
    body.prompt_cache_key = promptCaching.key;
  }

  if (promptCaching?.retention) {
    body.prompt_cache_retention = promptCaching.retention;
  }

  return body;
}

export function translateOpenAITool(tool: CanonicalTool): OpenAIToolDefinition {
  return {
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters,
    strict: false,
    type: 'function',
  };
}

export function translateOpenAIToolChoice(toolChoice: CanonicalToolChoice): {
  parallelToolCalls?: boolean;
  toolChoice: OpenAIToolChoice;
} {
  if (toolChoice.type === 'any') {
    return {
      toolChoice: 'required',
    };
  }

  if (toolChoice.type === 'tool') {
    return {
      ...(toolChoice.disableParallelToolUse !== undefined
        ? { parallelToolCalls: !toolChoice.disableParallelToolUse }
        : {}),
      toolChoice: {
        name: toolChoice.name,
        type: 'function',
      },
    };
  }

  return {
    toolChoice: toolChoice.type,
  };
}

export function translateOpenAIResponse(
  payload: OpenAIResponsePayload,
  modelRegistry: ModelRegistry = new ModelRegistry(),
  requestedModel?: string,
): CanonicalResponse {
  const resolvedModelId = resolveOpenAIModelId(payload.model, requestedModel, modelRegistry);
  const model = modelRegistry.get(resolvedModelId);
  const usage = usageWithCost(model, openaiUsageToCanonical(payload.usage));
  const content: CanonicalPart[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  const textSegments: string[] = [];
  let refusal: string | undefined;

  for (const item of payload.output ?? []) {
    if (isOpenAIMessageOutput(item) && item.role === 'assistant') {
      for (const part of item.content) {
        if (isOpenAIOutputTextPart(part)) {
          content.push({
            text: part.text,
            type: 'text',
          });
          textSegments.push(part.text);
          continue;
        }

        if (isOpenAIRefusalPart(part)) {
          refusal = refusal === undefined ? part.refusal : `${refusal}${part.refusal}`;
          content.push({
            text: part.refusal,
            type: 'text',
          });
          textSegments.push(part.refusal);
        }
      }
      continue;
    }

    if (isOpenAIFunctionCallOutput(item)) {
      const args = parseOpenAIToolArguments(
        item.arguments,
        payload.model,
        item.name,
      );
      content.push({
        args,
        id: item.call_id,
        name: item.name,
        type: 'tool_call',
      });
      toolCalls.push({
        args,
        id: item.call_id,
        name: item.name,
      });
    }
  }

  return {
    content,
    finishReason: normalizeOpenAIFinishReason(payload),
    model: resolvedModelId,
    provider: 'openai',
    raw: payload,
    ...(refusal !== undefined
      ? {
          refusal,
          structuredOutputStatus: 'refusal' as const,
        }
      : {}),
    text: textSegments.join(''),
    toolCalls,
    usage,
  };
}

function resolveOpenAIModelId(
  responseModel: string,
  requestedModel: string | undefined,
  modelRegistry: ModelRegistry,
): string {
  if (modelRegistry.isSupported(responseModel)) {
    return responseModel;
  }

  if (requestedModel && modelRegistry.isSupported(requestedModel)) {
    return requestedModel;
  }

  return responseModel;
}

export async function mapOpenAIError(
  response: Response,
  model?: string,
): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError> {
  const requestId =
    response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
  let body: OpenAIErrorBody | undefined;
  try {
    body = (await response.json()) as OpenAIErrorBody;
  } catch {
    body = undefined;
  }

  const message = body?.error?.message ?? `OpenAI request failed with ${response.status}.`;
  const code = body?.error?.code ?? undefined;
  const options = buildOpenAIErrorOptions(
    response.status,
    model,
    requestId,
    response.status === 429 || response.status >= 500,
  );

  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(message, options);
  }

  if (response.status === 429) {
    return new RateLimitError(message, options);
  }

  if (
    response.status === 400 &&
    (code === 'context_length_exceeded' || /context|token/i.test(message))
  ) {
    return new ContextLimitError(message, {
      ...options,
      retryable: false,
    });
  }

  return new ProviderError(message, options);
}

function normalizeUnixTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}

class OpenAIStreamAssembler {
  private finalResponse: OpenAIResponsePayload | undefined;
  private finishReason: CanonicalFinishReason = 'stop';
  private readonly model: string;
  private readonly modelRegistry: ModelRegistry;
  private readonly toolBuffer = new Map<
    string,
    { args: string; callId: string; name: string }
  >();

  constructor(model: string, modelRegistry: ModelRegistry) {
    this.model = model;
    this.modelRegistry = modelRegistry;
  }

  *consume(event: { [key: string]: unknown; type?: string }): Generator<StreamChunk> {
    switch (event.type) {
      case 'response.output_text.delta': {
        const typedEvent = event as unknown as OpenAIResponseOutputTextDeltaEvent;
        if (typedEvent.delta.length > 0) {
          yield {
            delta: typedEvent.delta,
            type: 'text-delta',
          };
        }
        return;
      }
      case 'response.output_item.added': {
        const typedEvent = event as unknown as OpenAIResponseOutputItemAddedEvent;
        yield* this.handleOutputItemAdded(typedEvent.item, typedEvent.output_index);
        return;
      }
      case 'response.function_call_arguments.delta':
        yield* this.handleFunctionCallArgumentsDelta(
          event as unknown as OpenAIResponseFunctionCallArgumentsDeltaEvent,
        );
        return;
      case 'response.function_call_arguments.done':
        this.handleFunctionCallArgumentsDone(
          event as unknown as OpenAIResponseFunctionCallArgumentsDoneEvent,
        );
        return;
      case 'response.output_item.done': {
        const typedEvent = event as unknown as OpenAIResponseOutputItemDoneEvent;
        yield* this.handleOutputItemDone(typedEvent.item, typedEvent.output_index);
        return;
      }
      case 'response.completed':
      case 'response.incomplete':
        this.finalResponse = (
          event as unknown as OpenAIResponseCompletedEvent | OpenAIResponseIncompleteEvent
        ).response;
        this.finishReason = normalizeOpenAIFinishReason(this.finalResponse);
        return;
      case 'response.failed':
        this.finalResponse = (event as unknown as OpenAIResponseFailedEvent).response;
        this.finishReason = normalizeOpenAIFinishReason(this.finalResponse);
        throw this.buildStreamError(this.finalResponse.error);
      case 'error':
        throw this.buildStreamError(event as unknown as OpenAIResponseErrorEvent);
      default:
        return;
    }
  }

  finish(): StreamChunk {
    const responseModel = this.finalResponse?.model ?? this.model;
    const resolvedModelId = resolveOpenAIModelId(
      responseModel,
      this.model,
      this.modelRegistry,
    );
    const model = this.modelRegistry.get(resolvedModelId);
    return {
      finishReason: this.finishReason,
      type: 'done',
      usage: usageWithCost(model, openaiUsageToCanonical(this.finalResponse?.usage)),
    };
  }

  private buildStreamError(
    error: OpenAIResponseErrorPayload | null | undefined,
  ): ProviderError {
    return new ProviderError(error?.message ?? 'OpenAI streaming request failed.', {
      model: this.model,
      provider: 'openai',
    });
  }

  private *handleOutputItemAdded(
    item: OpenAIOutputItem,
    outputIndex: number,
  ): Generator<StreamChunk> {
    if (!isOpenAIFunctionCallOutput(item)) {
      return;
    }

    const existing = this.toolBuffer.get(item.id);
    if (existing) {
      existing.callId = item.call_id;
      existing.name = item.name;
      if (item.arguments.length > existing.args.length) {
        existing.args = item.arguments;
      }
      return;
    }

    this.toolBuffer.set(item.id, {
      args: item.arguments,
      callId: item.call_id,
      name: item.name,
    });
    yield {
      id: item.call_id,
      name: item.name,
      type: 'tool-call-start',
    };

    if (item.arguments.length > 0) {
      yield {
        argsDelta: item.arguments,
        id: item.call_id,
        type: 'tool-call-delta',
      };
    }

    void outputIndex;
  }

  private *handleFunctionCallArgumentsDelta(
    event: OpenAIResponseFunctionCallArgumentsDeltaEvent,
  ): Generator<StreamChunk> {
    const tool = this.getOrCreateToolBuffer(event.item_id, event.output_index);
    tool.args += event.delta;
    yield {
      argsDelta: event.delta,
      id: tool.callId,
      type: 'tool-call-delta',
    };
  }

  private handleFunctionCallArgumentsDone(
    event: OpenAIResponseFunctionCallArgumentsDoneEvent,
  ): void {
    const tool = this.getOrCreateToolBuffer(event.item_id, event.output_index);
    tool.args = event.arguments;
    tool.name = event.name;
    if (event.call_id) {
      tool.callId = event.call_id;
    }
  }

  private *handleOutputItemDone(
    item: OpenAIOutputItem,
    outputIndex: number,
  ): Generator<StreamChunk> {
    if (!isOpenAIFunctionCallOutput(item)) {
      return;
    }

    const tool = this.getOrCreateToolBuffer(item.id, outputIndex);
    tool.args = item.arguments;
    tool.callId = item.call_id;
    tool.name = item.name;
    this.toolBuffer.delete(item.id);
    this.finishReason = 'tool_call';
    yield {
      id: tool.callId,
      name: tool.name,
      result: parseOpenAIToolArguments(tool.args, this.model, tool.name),
      type: 'tool-call-result',
    };
  }

  private getOrCreateToolBuffer(
    itemId: string,
    outputIndex: number,
  ): { args: string; callId: string; name: string } {
    const existing = this.toolBuffer.get(itemId);
    if (existing) {
      return existing;
    }

    const created = {
      args: '',
      callId: itemId,
      name: `tool_${outputIndex}`,
    };
    this.toolBuffer.set(itemId, created);
    return created;
  }
}

function translateOpenAISystemMessage(message: CanonicalMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (message.content.some((part) => part.type !== 'text')) {
    throw new ProviderCapabilityError(
      'OpenAI instructions currently support text content only.',
      {
        provider: 'openai',
      },
    );
  }

  const textParts = message.content.filter(
    (part): part is Extract<CanonicalPart, { type: 'text' }> => part.type === 'text',
  );

  return textParts.map((part) => part.text).join('\n\n');
}

function translateOpenAIMessage(message: CanonicalMessage): OpenAIInputItem[] {
  switch (message.role) {
    case 'assistant':
      return translateOpenAIAssistantMessage(message);
    case 'system':
      return [];
    case 'user':
      return translateOpenAIUserMessage(message);
  }
}

function translateOpenAIUserMessage(message: CanonicalMessage): OpenAIInputItem[] {
  if (typeof message.content === 'string') {
    return [
      {
        content: [
          {
            text: message.content,
            type: 'input_text',
          },
        ],
        role: 'user',
        type: 'message',
      },
    ];
  }

  const userParts: OpenAIInputContentPart[] = [];
  const items: OpenAIInputItem[] = [];

  for (const part of message.content) {
    switch (part.type) {
      case 'audio':
      case 'document':
        throw new ProviderCapabilityError(
          'OpenAI Responses do not support document or audio canonical parts in this adapter.',
          {
            provider: 'openai',
          },
        );
      case 'image_base64':
        userParts.push({
          image_url: `data:${part.mediaType};base64,${part.data}`,
          type: 'input_image',
        });
        break;
      case 'image_url':
        userParts.push({
          image_url: part.url,
          type: 'input_image',
        });
        break;
      case 'text':
        userParts.push({
          text: part.text,
          type: 'input_text',
        });
        break;
      case 'tool_call':
        throw new ProviderCapabilityError(
          'OpenAI tool calls must appear in assistant messages.',
          {
            provider: 'openai',
          },
        );
      case 'tool_result':
        items.push({
          call_id: part.toolCallId,
          output: stringifyToolResult(part.result),
          type: 'function_call_output',
        });
        break;
    }
  }

  if (userParts.length > 0) {
    items.unshift({
      content: userParts,
      role: 'user',
      type: 'message',
    });
  }

  return items;
}

function translateOpenAIAssistantMessage(message: CanonicalMessage): OpenAIInputItem[] {
  if (typeof message.content === 'string') {
    return [
      {
        content: [
          {
            text: message.content,
            type: 'input_text',
          },
        ],
        role: 'assistant',
        type: 'message',
      },
    ];
  }

  const items: OpenAIInputItem[] = [];
  const textParts: OpenAIInputContentPart[] = [];

  for (const part of message.content) {
    switch (part.type) {
      case 'audio':
      case 'document':
      case 'image_base64':
      case 'image_url':
      case 'tool_result':
        throw new ProviderCapabilityError(
          'Assistant messages in the OpenAI adapter support text and tool-call parts only.',
          {
            provider: 'openai',
          },
        );
      case 'text':
        textParts.push({
          text: part.text,
          type: 'input_text',
        });
        break;
      case 'tool_call':
        items.push({
          arguments: JSON.stringify(part.args),
          call_id: part.id,
          name: part.name,
          type: 'function_call',
        });
        break;
    }
  }

  if (textParts.length > 0) {
    items.unshift({
      content: textParts,
      role: 'assistant',
      type: 'message',
    });
  }

  return items;
}

function parseOpenAIToolArguments(
  argumentsJson: string,
  model: string,
  toolName: string,
): JsonObject {
  try {
    const parsed = JSON.parse(argumentsJson) as JsonValue;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parsed tool arguments were not an object.');
    }

    return parsed;
  } catch (error) {
    throw new ProviderError(
      `Failed to parse OpenAI tool arguments for "${toolName}".`,
      {
        cause: error,
        model,
        provider: 'openai',
      },
    );
  }
}

function normalizeOpenAIFinishReason(
  payload: Pick<OpenAIResponsePayload, 'error' | 'incomplete_details' | 'output' | 'status'>,
): CanonicalFinishReason {
  if ((payload.output ?? []).some(isOpenAIFunctionCallOutput)) {
    return 'tool_call';
  }

  if (payload.error || payload.status === 'failed') {
    return 'error';
  }

  const reason = payload.incomplete_details?.reason ?? '';
  if (reason.length > 0) {
    if (/content|filter|policy|safety/i.test(reason)) {
      return 'content_filter';
    }

    if (/length|max|token/i.test(reason)) {
      return 'length';
    }
  }

  if (payload.status === 'incomplete') {
    return 'length';
  }

  return 'stop';
}

function isOpenAIFunctionCallOutput(item: OpenAIOutputItem): item is OpenAIFunctionCallOutput {
  return item.type === 'function_call';
}

function isOpenAIMessageOutput(item: OpenAIOutputItem): item is OpenAIMessageOutput {
  return item.type === 'message';
}

function isOpenAIOutputTextPart(
  part: OpenAIOutputMessageContentPart,
): part is OpenAIOutputTextPart {
  return part.type === 'output_text';
}

function isOpenAIRefusalPart(
  part: OpenAIOutputMessageContentPart,
): part is OpenAIRefusalPart {
  return part.type === 'refusal';
}

function messageContainsUnsupportedOpenAIParts(message: CanonicalMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some(
      (part) => part.type === 'audio' || part.type === 'document',
    )
  );
}

function messageContainsVisionContent(message: CanonicalMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some(
      (part) => part.type === 'image_base64' || part.type === 'image_url',
    )
  );
}

function buildOpenAIErrorOptions(
  statusCode: number,
  model: string | undefined,
  requestId: string | undefined,
  retryable: boolean,
): {
  model?: string;
  provider: 'openai';
  requestId?: string;
  retryable: boolean;
  statusCode: number;
} {
  return {
    provider: 'openai',
    retryable,
    statusCode,
    ...(model !== undefined ? { model } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

function buildRequestInit(
  init: Omit<RequestInit, 'signal'>,
  signal: AbortSignal | undefined,
): RequestInit {
  if (!signal) {
    return init;
  }

  return {
    ...init,
    signal,
  };
}

function stringifyToolResult(result: JsonValue): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}
