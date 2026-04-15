export async function* parseSSE(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];
    const flushEvent = async function* () {
        if (dataLines.length === 0) {
            return;
        }
        const payload = dataLines.join('\n');
        dataLines = [];
        if (payload !== '[DONE]') {
            yield payload;
        }
    };
    const processLine = async function* (line) {
        if (line === '') {
            yield* flushEvent();
            return;
        }
        if (line.startsWith(':')) {
            return;
        }
        if (!line.startsWith('data:')) {
            return;
        }
        let payload = line.slice(5);
        if (payload.startsWith(' ')) {
            payload = payload.slice(1);
        }
        dataLines.push(payload);
    };
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            buffer += decoder.decode();
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let lineBreakIndex = buffer.search(/\r?\n/);
        while (lineBreakIndex >= 0) {
            const line = buffer.slice(0, lineBreakIndex);
            const separatorLength = buffer[lineBreakIndex] === '\r' ? 2 : 1;
            buffer = buffer.slice(lineBreakIndex + separatorLength);
            yield* processLine(line);
            lineBreakIndex = buffer.search(/\r?\n/);
        }
    }
    if (buffer.length > 0) {
        yield* processLine(buffer);
    }
    yield* flushEvent();
}
