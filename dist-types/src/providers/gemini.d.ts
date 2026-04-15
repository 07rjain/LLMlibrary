import { AuthenticationError, ContextLimitError, ProviderError, RateLimitError } from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import type { CanonicalMessage, CanonicalResponse, CanonicalTool, CanonicalToolChoice, CanonicalToolSchema, JsonObject, StreamChunk } from '../types.js';
import type { RetryOptions } from '../utils/retry.js';
type GeminiRole = 'model' | 'user';
type GeminiPart = GeminiTextPart | GeminiInlineDataPart | GeminiFileDataPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;
interface GeminiTextPart {
    text: string;
}
interface GeminiInlineDataPart {
    inlineData: {
        data: string;
        mimeType: string;
    };
}
interface GeminiFileDataPart {
    fileData: {
        fileUri: string;
        mimeType: string;
    };
}
interface GeminiFunctionCallPart {
    functionCall: {
        args: JsonObject;
        name: string;
    };
}
interface GeminiFunctionResponsePart {
    functionResponse: {
        name: string;
        response: JsonObject;
    };
}
interface GeminiContent {
    parts: GeminiPart[];
    role?: GeminiRole;
}
interface GeminiToolSchema {
    additionalProperties?: boolean;
    description?: string;
    enum?: readonly (boolean | null | number | string)[];
    items?: GeminiToolSchema;
    properties?: Record<string, GeminiToolSchema>;
    required?: readonly string[];
    type: Uppercase<CanonicalToolSchema['type']>;
}
interface GeminiFunctionDeclaration {
    description: string;
    name: string;
    parameters: GeminiToolSchema;
}
interface GeminiToolDefinition {
    functionDeclarations: GeminiFunctionDeclaration[];
}
interface GeminiToolConfig {
    functionCallingConfig: {
        allowedFunctionNames?: string[];
        mode: 'ANY' | 'AUTO' | 'NONE';
    };
}
interface GeminiUsageMetadata {
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    promptTokenCount?: number;
    totalTokenCount?: number;
}
type GeminiFinishReason = 'BLOCKLIST' | 'LANGUAGE' | 'MALFORMED_FUNCTION_CALL' | 'MAX_TOKENS' | 'OTHER' | 'PROHIBITED_CONTENT' | 'RECITATION' | 'SAFETY' | 'SPII' | 'STOP' | null;
interface GeminiCandidate {
    content?: GeminiContent;
    finishReason?: GeminiFinishReason;
    index: number;
    safetyRatings?: Array<{
        blocked?: boolean;
        category?: string;
        probability?: string;
    }>;
}
interface GeminiGenerateContentResponse {
    candidates?: GeminiCandidate[];
    modelVersion?: string;
    promptFeedback?: {
        blockReason?: string;
    };
    usageMetadata?: GeminiUsageMetadata;
}
export interface GeminiClientConfig {
    apiKey: string;
    baseUrl?: string;
    fetchImplementation?: typeof fetch;
    modelRegistry?: ModelRegistry;
    retryOptions?: RetryOptions;
}
export interface GeminiCompletionOptions {
    maxTokens?: number;
    messages: CanonicalMessage[];
    model: string;
    signal?: AbortSignal;
    system?: string;
    temperature?: number;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
}
export declare class GeminiAdapter {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly fetchImplementation;
    private readonly modelRegistry;
    private readonly retryOptions;
    constructor(config: GeminiClientConfig);
    complete(options: GeminiCompletionOptions): Promise<CanonicalResponse>;
    stream(options: GeminiCompletionOptions): AsyncGenerator<StreamChunk, void, void>;
    private assertCapabilities;
    private buildHeaders;
}
export declare function translateGeminiRequest(options: GeminiCompletionOptions): Record<string, unknown>;
export declare function translateGeminiTools(tools: CanonicalTool[]): GeminiToolDefinition;
export declare function translateGeminiTool(tool: CanonicalTool): GeminiFunctionDeclaration;
export declare function translateGeminiToolChoice(toolChoice: CanonicalToolChoice): GeminiToolConfig;
export declare function translateGeminiResponse(payload: GeminiGenerateContentResponse, requestedModel: string, modelRegistry?: ModelRegistry): CanonicalResponse;
export declare function mapGeminiError(response: Response, model?: string): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError>;
export {};
//# sourceMappingURL=gemini.d.ts.map