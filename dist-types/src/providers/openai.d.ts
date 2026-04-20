import { AuthenticationError, ContextLimitError, ProviderError, RateLimitError } from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import type { CanonicalMessage, CanonicalResponse, CanonicalTool, CanonicalToolChoice, StreamChunk } from '../types.js';
import type { OpenAIUsagePayload } from '../utils/cost.js';
import type { RetryOptions } from '../utils/retry.js';
interface OpenAIToolDefinition {
    description: string;
    name: string;
    parameters: CanonicalTool['parameters'];
    strict: false;
    type: 'function';
}
type OpenAIToolChoice = 'auto' | 'none' | 'required' | {
    name: string;
    type: 'function';
};
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
type OpenAIOutputMessageContentPart = OpenAIOutputTextPart | OpenAIRefusalPart | {
    type: string;
    [key: string]: unknown;
};
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
type OpenAIOutputItem = OpenAIFunctionCallOutput | OpenAIMessageOutput | {
    id?: string;
    type: string;
    [key: string]: unknown;
};
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
    signal?: AbortSignal;
    system?: string;
    temperature?: number;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
}
export declare class OpenAIAdapter {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly fetchImplementation;
    private readonly modelRegistry;
    private readonly organization;
    private readonly project;
    private readonly retryOptions;
    constructor(config: OpenAIClientConfig);
    complete(options: OpenAICompletionOptions): Promise<CanonicalResponse>;
    stream(options: OpenAICompletionOptions): AsyncGenerator<StreamChunk, void, void>;
    private assertCapabilities;
    private buildHeaders;
}
export declare function translateOpenAIRequest(options: OpenAICompletionOptions): Record<string, unknown>;
export declare function translateOpenAITool(tool: CanonicalTool): OpenAIToolDefinition;
export declare function translateOpenAIToolChoice(toolChoice: CanonicalToolChoice): {
    parallelToolCalls?: boolean;
    toolChoice: OpenAIToolChoice;
};
export declare function translateOpenAIResponse(payload: OpenAIResponsePayload, modelRegistry?: ModelRegistry, requestedModel?: string): CanonicalResponse;
export declare function mapOpenAIError(response: Response, model?: string): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError>;
export {};
//# sourceMappingURL=openai.d.ts.map