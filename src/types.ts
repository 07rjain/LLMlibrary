export type CanonicalProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'cohere'
  | 'groq'
  | 'bedrock'
  | 'azure-openai'
  | 'ollama'
  | 'mock';

export type CanonicalRole = 'system' | 'user' | 'assistant';

export type CanonicalFinishReason =
  | 'stop'
  | 'length'
  | 'tool_call'
  | 'content_filter'
  | 'error';

export interface CacheControl {
  ttl?: '1h' | '5m';
  type: 'ephemeral';
}

export type OpenAIReasoningEffort =
  | 'high'
  | 'low'
  | 'medium'
  | 'minimal'
  | 'none'
  | 'xhigh';

export interface OpenAIReasoningOptions {
  effort?: OpenAIReasoningEffort;
  includeEncryptedContent?: boolean;
  summary?: 'auto' | 'concise' | 'detailed';
}

export type AnthropicThinkingEffort = 'high' | 'low' | 'medium';

export interface AnthropicThinkingOptions {
  budgetTokens?: number;
  display?: 'omitted' | 'summarized';
  type: 'adaptive' | 'disabled' | 'enabled';
}

export interface AnthropicProviderOptions {
  cacheControl?: CacheControl;
  effort?: AnthropicThinkingEffort;
  thinking?: AnthropicThinkingOptions;
}

export interface OpenAIPromptCachingOptions {
  key?: string;
  retention?: '24h' | 'in_memory';
}

export interface OpenAIProviderOptions {
  promptCaching?: OpenAIPromptCachingOptions;
  reasoning?: OpenAIReasoningOptions;
}

export interface GooglePromptCachingOptions {
  cachedContent?: string;
}

export interface GoogleThinkingOptions {
  budgetTokens?: number;
  includeThoughts?: boolean;
  level?: 'high' | 'low' | 'medium' | 'minimal';
}

export interface GoogleProviderOptions {
  promptCaching?: GooglePromptCachingOptions;
  thinking?: GoogleThinkingOptions;
}

export interface ProviderOptions {
  anthropic?: AnthropicProviderOptions;
  google?: GoogleProviderOptions;
  openai?: OpenAIProviderOptions;
}

export interface CacheablePartBase {
  cacheControl?: CacheControl;
}

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export interface TextPart extends CacheablePartBase {
  type: 'text';
  text: string;
}

export interface ImageUrlPart extends CacheablePartBase {
  type: 'image_url';
  url: string;
  mediaType?: string;
}

export interface ImageBase64Part extends CacheablePartBase {
  type: 'image_base64';
  data: string;
  mediaType: string;
}

export interface DocumentPart extends CacheablePartBase {
  type: 'document';
  data?: string;
  mediaType: string;
  title?: string;
  url?: string;
}

export interface AudioPart {
  type: 'audio';
  data?: string;
  mediaType: string;
  url?: string;
}

export interface CanonicalToolCallPart extends CacheablePartBase {
  type: 'tool_call';
  args: JsonObject;
  id: string;
  name: string;
}

export interface CanonicalToolResultPart extends CacheablePartBase {
  type: 'tool_result';
  isError?: boolean;
  name?: string;
  result: JsonValue;
  toolCallId: string;
}

export type CanonicalPart =
  | AudioPart
  | CanonicalToolCallPart
  | CanonicalToolResultPart
  | DocumentPart
  | ImageBase64Part
  | ImageUrlPart
  | TextPart;

export interface CanonicalMessage {
  content: CanonicalPart[] | string;
  metadata?: Record<string, unknown>;
  pinned?: boolean;
  role: CanonicalRole;
}

export interface CanonicalToolSchema {
  additionalProperties?: boolean;
  description?: string;
  enum?: readonly JsonPrimitive[];
  items?: CanonicalToolSchema;
  properties?: Record<string, CanonicalToolSchema>;
  required?: readonly string[];
  type: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string';
}

export interface CanonicalJsonSchema {
  $defs?: Record<string, CanonicalJsonSchema>;
  $ref?: string;
  additionalProperties?: boolean | CanonicalJsonSchema;
  anyOf?: CanonicalJsonSchema[];
  description?: string;
  enum?: readonly JsonPrimitive[];
  format?: string;
  items?: CanonicalJsonSchema;
  maxItems?: number;
  maxLength?: number;
  maximum?: number;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  prefixItems?: CanonicalJsonSchema[];
  properties?: Record<string, CanonicalJsonSchema>;
  required?: readonly string[];
  title?: string;
  type?:
    | 'array'
    | 'boolean'
    | 'integer'
    | 'null'
    | 'number'
    | 'object'
    | 'string'
    | readonly (
        | 'array'
        | 'boolean'
        | 'integer'
        | 'null'
        | 'number'
        | 'object'
        | 'string'
      )[];
}

export type StructuredOutputMode = 'json_object' | 'json_schema' | 'text';
export type StructuredOutputStatus =
  | 'disabled'
  | 'parse_error'
  | 'parsed'
  | 'refusal';

export interface JsonObjectResponseFormat {
  parse?: boolean;
  type: 'json_object';
}

export interface JsonSchemaResponseFormat {
  name?: string;
  parse?: boolean;
  schema: CanonicalJsonSchema;
  strict?: boolean;
  type: 'json_schema';
}

export type ResponseFormat =
  | JsonObjectResponseFormat
  | JsonSchemaResponseFormat
  | { type: 'text' };

export interface ToolExecutionContext {
  model?: string;
  provider?: CanonicalProvider;
  signal?: AbortSignal;
  sessionId?: string;
  tenantId?: string;
}

export interface CanonicalTool<TArgs extends JsonObject = JsonObject> {
  cacheControl?: CacheControl;
  description: string;
  execute?: (
    args: TArgs,
    context?: ToolExecutionContext,
  ) => Promise<JsonValue> | JsonValue;
  name: string;
  parameters: CanonicalToolSchema;
}

export type CanonicalToolChoice =
  | { type: 'any' | 'auto' | 'none' }
  | { disableParallelToolUse?: boolean; name: string; type: 'tool' };

export interface CanonicalToolCall {
  args: JsonObject;
  id: string;
  name: string;
  result?: JsonValue;
}

/** Allows an integration to own tool execution outside the conversation runtime. */
export interface ToolCallDispatcher {
  execute(input: {
    call: CanonicalToolCall;
    metadata?: Record<string, JsonValue>;
    model: string;
    provider: CanonicalProvider;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<JsonValue>;
}

export type BudgetExceededAction = 'skip' | 'throw' | 'warn';

export interface CancelableStream<TChunk> extends AsyncIterable<TChunk> {
  cancel(reason?: unknown): void;
  readonly signal: AbortSignal;
}

export interface UsageMetrics {
  cachedReadTokens?: number;
  cachedTokens: number;
  cachedWriteTokens?: number;
  cost: string;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export type EmbeddingProvider = Extract<CanonicalProvider, 'google' | 'mock'>;

export type EmbeddingPurpose =
  | 'retrieval_document'
  | 'retrieval_query'
  | 'semantic_similarity'
  | 'classification'
  | 'clustering';

export type EmbeddingInputItem = CanonicalPart[] | string;
export type EmbeddingInput = EmbeddingInputItem | EmbeddingInputItem[];

export interface GoogleEmbeddingOptions {
  taskInstruction?: string;
  title?: string;
}

export interface EmbeddingProviderOptions {
  google?: GoogleEmbeddingOptions;
}

export interface EmbeddingRequestOptions {
  botId?: string;
  dimensions?: number;
  input: EmbeddingInput;
  model?: string;
  provider?: EmbeddingProvider;
  providerOptions?: EmbeddingProviderOptions;
  purpose?: EmbeddingPurpose;
  signal?: AbortSignal;
  tenantId?: string;
}

export interface EmbeddingResultItem {
  index: number;
  values: number[];
}

export interface EmbeddingUsageMetrics {
  cost?: string;
  costUSD?: number;
  estimated?: boolean;
  inputTokens?: number;
}

export interface EmbeddingResponse {
  embeddings: EmbeddingResultItem[];
  model: string;
  provider: EmbeddingProvider;
  raw: unknown;
  usage?: EmbeddingUsageMetrics;
}

export type SpeechProvider = Extract<CanonicalProvider, 'google' | 'mock' | 'openai'>;

export interface AudioInput {
  data?: string;
  file?: ArrayBuffer | Blob | Uint8Array;
  filename?: string;
  mediaType: string;
  url?: string;
}

export type TranscriptionHostnameResolver = (
  hostname: string,
) => Promise<string[]> | string[];

export interface TranscriptionUrlPolicy {
  allowedContentTypes?: string[];
  allowedHosts?: string[];
  allowedProtocols?: Array<'http:' | 'https:'>;
  blockPrivateNetworks?: boolean;
  enabled: boolean;
  maxBytes?: number;
  maxRedirects?: number;
  resolveHostname?: TranscriptionHostnameResolver;
}

export type SpeechOutputFormat = 'aac' | 'flac' | 'mp3' | 'opus' | 'pcm' | 'wav';

export interface OpenAISpeechOptions {
  chunkingStrategy?: 'auto' | JsonObject;
  include?: string[];
  knownSpeakerNames?: string[];
  knownSpeakerReferences?: string[];
}

export interface SpeechProviderOptions {
  openai?: OpenAISpeechOptions;
}

export interface SpeechRequestOptions {
  botId?: string;
  budgetExceededAction?: BudgetExceededAction;
  budgetUsd?: number;
  estimatedOutputSeconds?: number;
  format?: SpeechOutputFormat;
  input: string;
  maxOutputSeconds?: number;
  model?: string;
  provider?: SpeechProvider;
  providerOptions?: SpeechProviderOptions;
  sessionId?: string;
  signal?: AbortSignal;
  speed?: number;
  tenantId?: string;
  voice?: string | { id: string };
  instructions?: string;
}

export type TranscriptionResponseFormat =
  | 'diarized_json'
  | 'json'
  | 'srt'
  | 'text'
  | 'verbose_json'
  | 'vtt';

export interface TranscriptionRequestOptions {
  botId?: string;
  budgetExceededAction?: BudgetExceededAction;
  budgetUsd?: number;
  diarization?: boolean;
  input: AudioInput;
  inputAudioSeconds?: number;
  language?: string;
  model?: string;
  prompt?: string;
  provider?: SpeechProvider;
  providerOptions?: SpeechProviderOptions;
  responseFormat?: TranscriptionResponseFormat;
  sessionId?: string;
  signal?: AbortSignal;
  temperature?: number;
  tenantId?: string;
  timestampGranularities?: Array<'segment' | 'word'>;
  transcriptionUrlPolicy?: TranscriptionUrlPolicy;
}

export interface SpeechBillingUnits {
  audioInputTokens?: number;
  audioOutputTokens?: number;
  inputAudioSeconds?: number;
  inputCharacters?: number;
  inputTokens?: number;
  outputAudioSeconds?: number;
  outputCharacters?: number;
  outputTokens?: number;
}

export type SpeechCostUnit =
  | 'audio_input_token'
  | 'audio_output_token'
  | 'audio_second'
  | 'character'
  | 'request'
  | 'text_input_token'
  | 'text_output_token';

export interface SpeechCostLineItem {
  amountUSD: number;
  estimated: boolean;
  label: string;
  quantity: number;
  rateUSD: number;
  unit: SpeechCostUnit;
}

export interface SpeechUsageMetrics {
  audioInputTokens?: number;
  audioOutputTokens?: number;
  billingUnits?: SpeechBillingUnits;
  cost?: string;
  costBreakdown?: SpeechCostLineItem[];
  costUSD?: number;
  durationSeconds?: number;
  estimated?: boolean;
  inputAudioSeconds?: number;
  inputCharacters?: number;
  inputTokens?: number;
  outputAudioSeconds?: number;
  outputCharacters?: number;
  outputTokens?: number;
}

export interface SpeechResponse {
  audio: Uint8Array;
  format: SpeechOutputFormat | string;
  mediaType: string;
  model: string;
  provider: SpeechProvider;
  raw: unknown;
  usage?: SpeechUsageMetrics;
}

export interface TranscriptionSegment {
  confidence?: number;
  end?: number;
  id?: number | string;
  language?: string;
  speaker?: string;
  start?: number;
  text: string;
}

export interface TranscriptionWord {
  confidence?: number;
  end?: number;
  start?: number;
  text: string;
}

export interface TranscriptionResponse {
  durationSeconds?: number;
  language?: string;
  model: string;
  provider: SpeechProvider;
  raw: unknown;
  segments?: TranscriptionSegment[];
  text: string;
  usage?: SpeechUsageMetrics;
  words?: TranscriptionWord[];
}

export interface CanonicalResponse {
  content: CanonicalPart[];
  finishReason: CanonicalFinishReason;
  model: string;
  parsed?: JsonValue;
  parseError?: string;
  provider: CanonicalProvider;
  raw: unknown;
  refusal?: string;
  responseFormat?: StructuredOutputMode;
  structuredOutputStatus?: StructuredOutputStatus;
  text: string;
  toolCalls: CanonicalToolCall[];
  usage: UsageMetrics;
}

export const STREAM_EVENT_VERSION = 2 as const;
export type StreamEventVersion = typeof STREAM_EVENT_VERSION;

export interface StreamEventBase {
  requestId?: string;
  sequence?: number;
  timestamp?: string;
  version?: StreamEventVersion;
}

export type StreamChunk =
  | (StreamEventBase & { delta: string; type: 'text-delta' })
  | (StreamEventBase & { id: string; name: string; type: 'tool-call-start' })
  | (StreamEventBase & { argsDelta: string; id: string; type: 'tool-call-delta' })
  | (StreamEventBase & {
      id: string;
      name: string;
      result: JsonValue;
      type: 'tool-call-result';
    })
  | (StreamEventBase & {
      finishReason: CanonicalFinishReason;
      type: 'done';
      usage: UsageMetrics;
    })
  | (StreamEventBase & { error: Error; type: 'error' })
  | (StreamEventBase & {
      model: string;
      provider: CanonicalProvider;
      type: 'response-start';
    })
  | (StreamEventBase & { type: 'reasoning-start' })
  | (StreamEventBase & { delta: string; type: 'reasoning-delta' })
  | (StreamEventBase & { type: 'reasoning-end' })
  | (StreamEventBase & { type: 'usage-update'; usage: UsageMetrics })
  | (StreamEventBase & {
      attempt: number;
      error?: Error;
      type: 'retry';
    })
  | (StreamEventBase & {
      status: 'refusal' | 'structured-output';
      type: 'response-status';
    });

export interface UsageEvent extends UsageMetrics {
  botId?: string;
  durationMs: number;
  finishReason: CanonicalFinishReason;
  model: string;
  provider: CanonicalProvider;
  routingDecision?: string;
  sessionId?: string;
  tenantId?: string;
  timestamp: string;
}

export interface ModelInfo {
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  contextWindow: number;
  embeddingDimensions?: {
    default: number;
    max?: number;
    min?: number;
    recommended?: number[];
  };
  id: string;
  inputPrice: number;
  kind?: 'completion' | 'embedding' | 'speech' | 'transcription';
  lastUpdated: string;
  maxInputTokens?: number;
  outputPrice: number;
  provider: CanonicalProvider;
  supportedInputModalities?: Array<'audio' | 'document' | 'image' | 'text' | 'video'>;
  speechPrices?: SpeechPriceBook;
  supportedOutputModalities?: Array<'audio' | 'text'>;
  supportsJsonObjectOutput?: boolean;
  supportsJsonSchemaOutput?: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutputStreaming?: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface SpeechPriceBook {
  audioInputTokenPrice?: number;
  audioOutputTokenPrice?: number;
  characterInputPrice?: number;
  characterOutputPrice?: number;
  inputAudioSecondPrice?: number;
  outputAudioSecondPrice?: number;
  requestPrice?: number;
  textInputTokenPrice?: number;
  textOutputTokenPrice?: number;
}

export type ModelCapability = keyof Pick<
  ModelInfo,
  | 'supportsJsonObjectOutput'
  | 'supportsJsonSchemaOutput'
  | 'supportsStreaming'
  | 'supportsStructuredOutputStreaming'
  | 'supportsTools'
  | 'supportsVision'
>;

export type RemoteModelProvider = Extract<
  CanonicalProvider,
  'anthropic' | 'google' | 'openai'
>;

export interface RemoteModelInfo {
  createdAt?: string;
  displayName?: string;
  id: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  ownedBy?: string;
  provider: RemoteModelProvider;
  providerId?: string;
  raw: unknown;
  supportedActions?: string[];
}

export interface RemoteModelListOptions {
  provider: RemoteModelProvider;
}
