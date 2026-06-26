import type { CanonicalJsonSchema, CanonicalMessage, CanonicalProvider, CanonicalResponse, ModelInfo, ResponseFormat } from './types.js';
export declare function assertResponseFormatSupported(model: ModelInfo, responseFormat: ResponseFormat | undefined, options?: {
    stream?: boolean;
}): void;
export declare function buildOpenAITextFormat(responseFormat: ResponseFormat | undefined, options: {
    messages: CanonicalMessage[];
    system?: string;
}): Record<string, unknown> | undefined;
export declare function buildGeminiResponseFormat(responseFormat: ResponseFormat | undefined): Record<string, unknown> | undefined;
export declare function buildAnthropicOutputConfig(responseFormat: ResponseFormat | undefined): Record<string, unknown> | undefined;
export declare function parseStructuredOutput(response: CanonicalResponse, responseFormat: ResponseFormat | undefined): CanonicalResponse;
export declare function normalizeStructuredSchema(schema: CanonicalJsonSchema, provider: CanonicalProvider, options?: {
    root?: boolean;
    strict?: boolean;
}): Record<string, unknown>;
//# sourceMappingURL=structured-output.d.ts.map