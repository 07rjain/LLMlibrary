import { loadOpenAITokenizer } from '../openai-tokenizer-loader.js';
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
export async function openaiCountTokens(options) {
    const encoding = await resolveOpenAIEncoding(options.model);
    const messages = [
        ...(options.system
            ? [{ content: options.system, role: 'developer' }]
            : []),
        ...options.messages.map(serializeOpenAIMessage),
    ];
    let total = 3;
    for (const message of messages) {
        total += 3;
        total += encoding.encode(message.role).length;
        total += encoding.encode(message.content).length;
    }
    if (options.tools && options.tools.length > 0) {
        total += encoding.encode(JSON.stringify(options.tools.map(serializeOpenAITool))).length;
    }
    if (options.toolChoice) {
        total += encoding.encode(JSON.stringify(options.toolChoice)).length;
    }
    return total;
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
async function resolveOpenAIEncoding(model) {
    const { encodingForModel, getEncoding } = await loadOpenAITokenizer();
    try {
        return encodingForModel(model);
    }
    catch {
        return getEncoding('o200k_base');
    }
}
function serializeOpenAIMessage(message) {
    if (message.role === 'system') {
        return {
            content: serializeOpenAIContent(message.content),
            role: 'developer',
        };
    }
    const parts = typeof message.content === 'string' ? [] : message.content;
    const hasToolResults = parts.some((part) => part.type === 'tool_result');
    if (hasToolResults && parts.length === 1 && parts[0]?.type === 'tool_result') {
        return {
            content: JSON.stringify({
                toolCallId: parts[0].toolCallId,
                result: parts[0].result,
            }),
            role: 'tool',
        };
    }
    return {
        content: serializeOpenAIContent(message.content),
        role: message.role,
    };
}
function serializeOpenAIContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    return content.map(serializeOpenAIPart).join('\n');
}
function serializeOpenAIPart(part) {
    switch (part.type) {
        case 'audio':
        case 'document':
        case 'image_base64':
        case 'image_url':
            throw new Error(`OpenAI token counting only supports text and tool message parts. Received "${part.type}".`);
        case 'text':
            return part.text;
        case 'tool_call':
            return JSON.stringify({
                args: part.args,
                id: part.id,
                name: part.name,
                type: part.type,
            });
        case 'tool_result':
            return JSON.stringify({
                isError: part.isError ?? false,
                name: part.name,
                result: part.result,
                toolCallId: part.toolCallId,
                type: part.type,
            });
    }
}
function serializeOpenAITool(tool) {
    return {
        function: {
            description: tool.description,
            name: tool.name,
            parameters: tool.parameters,
        },
        type: 'function',
    };
}
