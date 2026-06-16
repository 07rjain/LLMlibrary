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
    'claude-fable-5': {
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "anthropic";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gpt-5.5': {
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
    'gemini-3.5-flash': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "google";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gemini-3.1-pro-preview': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "google";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gemini-3.1-flash-lite': {
        cacheReadPrice: number;
        contextWindow: number;
        inputPrice: number;
        lastUpdated: string;
        outputPrice: number;
        provider: "google";
        supportsStreaming: true;
        supportsTools: true;
        supportsVision: true;
    };
    'gemini-embedding-2': {
        contextWindow: number;
        embeddingDimensions: {
            default: number;
            max: number;
            recommended: number[];
        };
        inputPrice: number;
        kind: "embedding";
        lastUpdated: string;
        maxInputTokens: number;
        outputPrice: number;
        provider: "google";
        supportedInputModalities: ("audio" | "document" | "image" | "text")[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'gpt-4o-mini-tts': {
        contextWindow: number;
        inputPrice: number;
        kind: "speech";
        lastUpdated: string;
        maxInputTokens: number;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            outputAudioSecondPrice: number;
            textInputTokenPrice: number;
        };
        supportedInputModalities: "text"[];
        supportedOutputModalities: "audio"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'gpt-4o-mini-tts-2025-12-15': {
        contextWindow: number;
        inputPrice: number;
        kind: "speech";
        lastUpdated: string;
        maxInputTokens: number;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            outputAudioSecondPrice: number;
            textInputTokenPrice: number;
        };
        supportedInputModalities: "text"[];
        supportedOutputModalities: "audio"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'tts-1': {
        contextWindow: number;
        inputPrice: number;
        kind: "speech";
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            characterInputPrice: number;
        };
        supportedInputModalities: "text"[];
        supportedOutputModalities: "audio"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'tts-1-hd': {
        contextWindow: number;
        inputPrice: number;
        kind: "speech";
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            characterInputPrice: number;
        };
        supportedInputModalities: "text"[];
        supportedOutputModalities: "audio"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'gpt-4o-mini-transcribe': {
        contextWindow: number;
        inputPrice: number;
        kind: "transcription";
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            inputAudioSecondPrice: number;
        };
        supportedInputModalities: "audio"[];
        supportedOutputModalities: "text"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'gpt-4o-mini-transcribe-2025-12-15': {
        contextWindow: number;
        inputPrice: number;
        kind: "transcription";
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            inputAudioSecondPrice: number;
        };
        supportedInputModalities: "audio"[];
        supportedOutputModalities: "text"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'gpt-4o-transcribe': {
        contextWindow: number;
        inputPrice: number;
        kind: "transcription";
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            inputAudioSecondPrice: number;
        };
        supportedInputModalities: "audio"[];
        supportedOutputModalities: "text"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'gpt-4o-transcribe-diarize': {
        contextWindow: number;
        inputPrice: number;
        kind: "transcription";
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            inputAudioSecondPrice: number;
        };
        supportedInputModalities: "audio"[];
        supportedOutputModalities: "text"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
    'whisper-1': {
        contextWindow: number;
        inputPrice: number;
        kind: "transcription";
        lastUpdated: string;
        outputPrice: number;
        provider: "openai";
        speechPrices: {
            inputAudioSecondPrice: number;
        };
        supportedInputModalities: "audio"[];
        supportedOutputModalities: "text"[];
        supportsStreaming: false;
        supportsTools: false;
        supportsVision: false;
    };
};
//# sourceMappingURL=prices.d.ts.map
