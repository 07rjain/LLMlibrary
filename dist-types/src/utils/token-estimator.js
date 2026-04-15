export function estimateTokens(text) {
    return Math.ceil(text.length / 3.5);
}
export function estimateMessageTokens(messages) {
    return messages.reduce((total, message) => {
        return total + estimateMessageContentTokens(message.content) + 4;
    }, 0);
}
export async function anthropicCountTokens(options) {
    const fetchImplementation = options.fetchImplementation ?? fetch;
    const response = await fetchImplementation(options.url ?? 'https://api.anthropic.com/v1/messages/count_tokens', buildRequestInit({
        body: JSON.stringify(options.body),
        headers: {
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
        },
        method: 'POST',
    }, options.signal));
    if (!response.ok) {
        throw new Error(`Anthropic token count request failed with ${response.status}.`);
    }
    const body = (await response.json());
    return body.input_tokens ?? 0;
}
export async function geminiCountTokens(options) {
    const fetchImplementation = options.fetchImplementation ?? fetch;
    const baseUrl = options.url ??
        `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:countTokens`;
    const response = await fetchImplementation(baseUrl, buildRequestInit({
        body: JSON.stringify(options.body),
        headers: {
            'content-type': 'application/json',
            'x-goog-api-key': options.apiKey,
        },
        method: 'POST',
    }, options.signal));
    if (!response.ok) {
        throw new Error(`Gemini token count request failed with ${response.status}.`);
    }
    const body = (await response.json());
    return body.totalTokens ?? 0;
}
function estimateMessageContentTokens(content) {
    if (typeof content === 'string') {
        return estimateTokens(content);
    }
    return content.reduce((total, part) => total + estimatePartTokens(part), 0);
}
function estimatePartTokens(part) {
    switch (part.type) {
        case 'audio':
            return estimateTokens(part.url ?? part.data ?? '');
        case 'document':
            return estimateTokens(part.title ?? '') + estimateTokens(part.url ?? part.data ?? '');
        case 'image_base64':
            return estimateTokens(part.data);
        case 'image_url':
            return estimateTokens(part.url);
        case 'text':
            return estimateTokens(part.text);
        case 'tool_call':
            return estimateTokens(`${part.name}${JSON.stringify(part.args)}`);
        case 'tool_result':
            return estimateTokens(`${part.name ?? ''}${part.toolCallId}${JSON.stringify(part.result)}`);
    }
}
function buildRequestInit(init, signal) {
    if (!signal) {
        return init;
    }
    return {
        ...init,
        signal,
    };
}
