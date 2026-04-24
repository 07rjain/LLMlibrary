export type CanonicalProvider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'cohere' | 'groq' | 'bedrock' | 'azure-openai' | 'ollama' | 'mock';
export type CanonicalRole = 'system' | 'user' | 'assistant';
export type CanonicalFinishReason = 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error';
export interface CacheControl {
    ttl?: '1h' | '5m';
    type: 'ephemeral';
}
export interface AnthropicProviderOptions {
    cacheControl?: CacheControl;
}
export interface OpenAIPromptCachingOptions {
    key?: string;
    retention?: '24h' | 'in_memory';
}
export interface OpenAIProviderOptions {
    promptCaching?: OpenAIPromptCachingOptions;
}
export interface GooglePromptCachingOptions {
    cachedContent?: string;
}
export interface GoogleProviderOptions {
    promptCaching?: GooglePromptCachingOptions;
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
export type CanonicalPart = AudioPart | CanonicalToolCallPart | CanonicalToolResultPart | DocumentPart | ImageBase64Part | ImageUrlPart | TextPart;
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
export interface ToolExecutionContext {
    model?: string;
    provider?: CanonicalProvider;
    sessionId?: string;
    tenantId?: string;
}
export interface CanonicalTool<TArgs extends JsonObject = JsonObject> {
    cacheControl?: CacheControl;
    description: string;
    execute?: (args: TArgs, context?: ToolExecutionContext) => Promise<JsonValue> | JsonValue;
    name: string;
    parameters: CanonicalToolSchema;
}
export type CanonicalToolChoice = {
    type: 'any' | 'auto' | 'none';
} | {
    disableParallelToolUse?: boolean;
    name: string;
    type: 'tool';
};
export interface CanonicalToolCall {
    args: JsonObject;
    id: string;
    name: string;
    result?: JsonValue;
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
}
export type EmbeddingProvider = Extract<CanonicalProvider, 'google' | 'mock'>;
export type EmbeddingPurpose = 'retrieval_document' | 'retrieval_query' | 'semantic_similarity' | 'classification' | 'clustering';
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
export interface CanonicalResponse {
    content: CanonicalPart[];
    finishReason: CanonicalFinishReason;
    model: string;
    provider: CanonicalProvider;
    raw: unknown;
    text: string;
    toolCalls: CanonicalToolCall[];
    usage: UsageMetrics;
}
export type StreamChunk = {
    delta: string;
    type: 'text-delta';
} | {
    id: string;
    name: string;
    type: 'tool-call-start';
} | {
    argsDelta: string;
    id: string;
    type: 'tool-call-delta';
} | {
    id: string;
    name: string;
    result: JsonValue;
    type: 'tool-call-result';
} | {
    finishReason: CanonicalFinishReason;
    type: 'done';
    usage: UsageMetrics;
} | {
    error: Error;
    type: 'error';
};
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
    kind?: 'completion' | 'embedding';
    lastUpdated: string;
    maxInputTokens?: number;
    outputPrice: number;
    provider: CanonicalProvider;
    supportedInputModalities?: Array<'audio' | 'document' | 'image' | 'text' | 'video'>;
    supportsStreaming: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
}
export type ModelCapability = keyof Pick<ModelInfo, 'supportsStreaming' | 'supportsTools' | 'supportsVision'>;
export type RemoteModelProvider = Extract<CanonicalProvider, 'anthropic' | 'google' | 'openai'>;
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
//# sourceMappingURL=types.d.ts.map