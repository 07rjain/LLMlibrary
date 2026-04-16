import type { CancelableStream } from './types.js';
export declare function buildAbortError(reason: unknown): Error;
export declare function createCancelableStream<TChunk>(iterate: (signal: AbortSignal) => AsyncGenerator<TChunk, void, void>, upstreamSignal?: AbortSignal): CancelableStream<TChunk>;
export declare function throwIfAborted(signal: AbortSignal | undefined): void;
//# sourceMappingURL=stream-control.d.ts.map