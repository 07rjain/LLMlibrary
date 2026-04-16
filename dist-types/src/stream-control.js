export function buildAbortError(reason) {
    if (reason instanceof Error) {
        return reason;
    }
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}
export function createCancelableStream(iterate, upstreamSignal) {
    const controller = new AbortController();
    const removeUpstreamListener = subscribeAbortSignal(upstreamSignal, controller);
    let iterator;
    let closed = false;
    const close = () => {
        if (closed) {
            return;
        }
        closed = true;
        removeUpstreamListener?.();
    };
    return {
        cancel(reason) {
            if (!controller.signal.aborted) {
                controller.abort(reason);
            }
            close();
        },
        get signal() {
            return controller.signal;
        },
        [Symbol.asyncIterator]() {
            if (!iterator) {
                iterator = (async function* () {
                    try {
                        yield* iterate(controller.signal);
                    }
                    finally {
                        close();
                    }
                })();
            }
            return iterator;
        },
    };
}
export function throwIfAborted(signal) {
    if (!signal?.aborted) {
        return;
    }
    throw buildAbortError(signal.reason);
}
function subscribeAbortSignal(upstreamSignal, controller) {
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
