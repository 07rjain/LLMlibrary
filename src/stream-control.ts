import type { CancelableStream } from './types.js';

export function buildAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

export function createCancelableStream<TChunk>(
  iterate: (signal: AbortSignal) => AsyncGenerator<TChunk, void, void>,
  upstreamSignal?: AbortSignal,
): CancelableStream<TChunk> {
  const controller = new AbortController();
  const removeUpstreamListener = subscribeAbortSignal(upstreamSignal, controller);

  let iterator: AsyncGenerator<TChunk, void, void> | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    removeUpstreamListener?.();
  };

  return {
    cancel(reason?: unknown): void {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
      close();
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
    [Symbol.asyncIterator](): AsyncGenerator<TChunk, void, void> {
      if (!iterator) {
        iterator = (async function* (): AsyncGenerator<TChunk, void, void> {
          try {
            yield* iterate(controller.signal);
          } finally {
            close();
          }
        })();
      }

      return iterator;
    },
  };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw buildAbortError(signal.reason);
}

function subscribeAbortSignal(
  upstreamSignal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!upstreamSignal) {
    return undefined;
  }

  if (upstreamSignal.aborted) {
    controller.abort(upstreamSignal.reason);
    return undefined;
  }

  const onAbort = () => {
    controller.abort(upstreamSignal.reason);
  };

  upstreamSignal.addEventListener('abort', onAbort, { once: true });
  return () => {
    upstreamSignal.removeEventListener('abort', onAbort);
  };
}
