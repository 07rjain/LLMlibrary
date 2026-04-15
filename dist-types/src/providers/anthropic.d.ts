import { AuthenticationError, ContextLimitError, ProviderError, RateLimitError } from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import type { CacheControl, CanonicalMessage, CanonicalResponse, CanonicalTool, CanonicalToolChoice, JsonObject, StreamChunk } from '../types.js';
import type { RetryOptions } from '../utils/retry.js';
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
interface AnthropicTextBlock {
    cache_control?: CacheControl;
    text: string;
    type: 'text';
}
interface AnthropicImageBlock {
    source: {
        type: 'url';
        url: string;
    } | {
        data: string;
        media_type: string;
        type: 'base64';
    };
    type: 'image';
}
interface AnthropicDocumentBlock {
    source: {
        type: 'url';
        url: string;
    } | {
        data: string;
        media_type: string;
        type: 'base64';
    };
    title?: string;
    type: 'document';
}
interface AnthropicToolUseBlock {
    id: string;
    input: JsonObject;
    name: string;
    type: 'tool_use';
}
interface AnthropicToolResultBlock {
    content: string;
    is_error?: boolean;
    tool_use_id: string;
    type: 'tool_result';
}
interface AnthropicToolDefinition {
    description: string;
    input_schema: CanonicalTool['parameters'];
    name: string;
}
type AnthropicToolChoice = {
    type: 'any' | 'auto' | 'none';
} | {
    disable_parallel_tool_use?: boolean;
    name: string;
    type: 'tool';
};
interface AnthropicUsage {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
}
interface AnthropicResponsePayload {
    content: AnthropicContentBlock[];
    id: string;
    model: string;
    role: 'assistant';
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    usage?: AnthropicUsage;
}
export interface AnthropicClientConfig {
    apiKey: string;
    baseUrl?: string;
    fetchImplementation?: typeof fetch;
    modelRegistry?: ModelRegistry;
    retryOptions?: RetryOptions;
}
export interface AnthropicCompletionOptions {
    maxTokens: number;
    messages: CanonicalMessage[];
    model: string;
    signal?: AbortSignal;
    system?: string;
    temperature?: number;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
}
export declare class AnthropicAdapter {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly fetchImplementation;
    private readonly modelRegistry;
    private readonly retryOptions;
    constructor(config: AnthropicClientConfig);
    complete(options: AnthropicCompletionOptions): Promise<CanonicalResponse>;
    stream(options: AnthropicCompletionOptions): AsyncGenerator<StreamChunk, void, void>;
    private assertCapabilities;
}
export declare function translateAnthropicRequest(options: AnthropicCompletionOptions): Record<string, unknown>;
export declare function translateAnthropicTool(tool: CanonicalTool): AnthropicToolDefinition;
export declare function translateAnthropicToolChoice(toolChoice: CanonicalToolChoice): AnthropicToolChoice;
export declare function translateAnthropicResponse(payload: AnthropicResponsePayload, modelRegistry?: ModelRegistry): CanonicalResponse;
export declare function mapAnthropicError(response: Response, model?: string): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError>;
export {};
//# sourceMappingURL=anthropic.d.ts.map