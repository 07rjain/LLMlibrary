import { LLMClient } from '../../src/client.js';
import type { CanonicalProvider, CanonicalResponse, CanonicalTool, JsonObject, StreamChunk, UsageMetrics } from '../../src/types.js';
export declare const liveRealEnabled: boolean;
export declare const providerModels: {
    readonly anthropic: string;
    readonly gemini: string;
    readonly geminiThinking: string;
    readonly openai: string;
};
export declare const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
export declare function hasEnv(name: string): boolean;
export declare function requireLiveEnv(name: string): void;
export declare function runId(prefix?: string): string;
export declare function liveClient(): LLMClient;
export declare function weatherTool(execute?: CanonicalTool['execute']): CanonicalTool;
export declare function collectStream(stream: AsyncIterable<StreamChunk>): Promise<{
    done: Extract<StreamChunk, {
        type: 'done';
    }> | undefined;
    text: string;
    toolCalls: number;
}>;
export declare function assertCanonicalResponse(response: CanonicalResponse, expectedProvider: CanonicalProvider): void;
export declare function assertUsage(usage: UsageMetrics): void;
export declare function expectNoSecretLeak(value: unknown): void;
export declare function strictJsonObject(value: unknown): JsonObject;
//# sourceMappingURL=helpers.d.ts.map