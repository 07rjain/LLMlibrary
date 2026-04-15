export type CanonicalProvider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'cohere' | 'groq' | 'bedrock' | 'azure-openai' | 'ollama' | 'mock';
export type CanonicalRole = 'system' | 'user' | 'assistant';
export type CanonicalFinishReason = 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error';
export interface CacheControl {
    ttl?: '1h' | '5m';
    type: 'ephemeral';
}
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;
export interface JsonObject {
    [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
export interface TextPart {
    cacheControl?: CacheControl;
    type: 'text';
    text: string;
}
export interface ImageUrlPart {
    type: 'image_url';
    url: string;
    mediaType?: string;
}
export interface ImageBase64Part {
    type: 'image_base64';
    data: string;
    mediaType: string;
}
export interface DocumentPart {
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
export interface CanonicalToolCallPart {
    type: 'tool_call';
    args: JsonObject;
    id: string;
    name: string;
}
export interface CanonicalToolResultPart {
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
export interface UsageMetrics {
    cachedReadTokens?: number;
    cachedTokens: number;
    cachedWriteTokens?: number;
    cost: string;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
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
    id: string;
    inputPrice: number;
    lastUpdated: string;
    outputPrice: number;
    provider: CanonicalProvider;
    supportsStreaming: boolean;
    supportsTools: boolean;
    supportsVision: boolean;
}
export type ModelCapability = keyof Pick<ModelInfo, 'supportsStreaming' | 'supportsTools' | 'supportsVision'>;
//# sourceMappingURL=types.d.ts.map