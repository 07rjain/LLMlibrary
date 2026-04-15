import type { ModelInfo } from '../types.js';
export type RawModelRegistry = Record<string, Omit<ModelInfo, 'id'>>;
export declare const defaultModelPrices: {
    'claude-sonnet-4-6': {
        cacheReadPrice: number;
        cacheWritePrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "anthropic";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'claude-haiku-4-5': {
        cacheReadPrice: number;
        cacheWritePrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "anthropic";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'claude-opus-4-6': {
        cacheReadPrice: number;
        cacheWritePrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "anthropic";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gpt-5.4': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gpt-5.4-mini': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gpt-5.4-nano': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: false;
    };
    'gpt-4o': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gpt-4o-mini': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    o3: {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gemini-2.5-pro': {
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "google";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gemini-2.5-flash': {
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "google";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gemini-2.5-flash-lite': {
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "google";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
};
//# sourceMappingURL=prices.d.ts.map