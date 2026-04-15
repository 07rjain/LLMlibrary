import { AuthenticationError, ContextLimitError, ProviderError, RateLimitError } from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import type { CanonicalMessage, CanonicalResponse, CanonicalTool, CanonicalToolChoice, StreamChunk } from '../types.js';
import type { RetryOptions } from '../utils/retry.js';
interface OpenAIToolCall {
    function: {
        arguments: string;
        name: string;
    };
    id: string;
    type: 'function';
}
interface OpenAIToolDefinition {
    function: {
        description: string;
        name: string;
        parameters: CanonicalTool['parameters'];
    };
    type: 'function';
}
type OpenAIToolChoice = 'auto' | 'none' | 'required' | {
    function: {
        name: string;
    };
    type: 'function';
};
interface OpenAIUsagePayload {
    completion_tokens?: number;
    prompt_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    total_tokens?: number;
}
interface OpenAIChatCompletionPayload {
    choices: Array<{
        finish_reason: 'content_filter' | 'function_call' | 'length' | 'stop' | 'tool_calls' | null;
        index: number;
        message: {
            annotations?: unknown[];
            content: null | string;
            refusal?: string | null;
            role: 'assistant';
            tool_calls?: OpenAIToolCall[];
        };
    }>;
    created: number;
    id: string;
    model: string;
    object: 'chat.completion';
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
export declare function translateOpenAIResponse(payload: OpenAIChatCompletionPayload, modelRegistry?: ModelRegistry, requestedModel?: string): CanonicalResponse;
export declare function mapOpenAIError(response: Response, model?: string): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError>;
export {};
//# sourceMappingURL=openai.d.ts.map