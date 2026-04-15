import { AuthenticationError, ContextLimitError, ProviderCapabilityError, ProviderError, RateLimitError, } from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import { openaiUsageToCanonical, usageWithCost } from '../utils/cost.js';
import { parseSSE } from '../utils/parse-sse.js';
import { withRetry } from '../utils/retry.js';
export class OpenAIAdapter {
    apiKey;
    baseUrl;
    fetchImplementation;
    modelRegistry;
    organization;
    project;
    retryOptions;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
        this.fetchImplementation = config.fetchImplementation ?? fetch;
        this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
        this.organization = config.organization;
        this.project = config.project;
        this.retryOptions = config.retryOptions;
    }
    async complete(options) {
        this.assertCapabilities(options);
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1/chat/completions`, buildRequestInit({
            body: JSON.stringify(translateOpenAIRequest(options)),
            headers: this.buildHeaders(),
            method: 'POST',
        }, options.signal)), this.retryOptions);
        if (!response.ok) {
            throw await mapOpenAIError(response, options.model);
        }
        const payload = (await response.json());
        return translateOpenAIResponse(payload, this.modelRegistry, options.model);
    }
    async *stream(options) {
        this.assertCapabilities({ ...options, stream: true });
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1/chat/completions`, buildRequestInit({
            body: JSON.stringify({
                ...translateOpenAIRequest(options),
                stream: true,
                stream_options: { include_usage: true },
            }),
            headers: this.buildHeaders(),
            method: 'POST',
        }, options.signal)), this.retryOptions);
        if (!response.ok) {
            throw await mapOpenAIError(response, options.model);
        }
        if (!response.body) {
            throw new ProviderError('OpenAI streaming response did not include a body.', {
                model: options.model,
                provider: 'openai',
            });
        }
        const assembler = new OpenAIStreamAssembler(options.model, this.modelRegistry);
        for await (const payload of parseSSE(response.body)) {
            const chunk = JSON.parse(payload);
            yield* assembler.consume(chunk);
        }
        yield assembler.finish();
    }
    assertCapabilities(options) {
        if (options.tools && options.tools.length > 0) {
            this.modelRegistry.assertCapability(options.model, 'supportsTools', 'tool calling');
        }
        if (options.stream) {
            this.modelRegistry.assertCapability(options.model, 'supportsStreaming', 'streaming');
        }
        if (options.messages.some(messageContainsVisionContent)) {
            this.modelRegistry.assertCapability(options.model, 'supportsVision', 'vision');
        }
        if (options.messages.some(messageContainsUnsupportedOpenAIParts)) {
            throw new ProviderCapabilityError(`Model "${options.model}" request includes unsupported content parts for the OpenAI chat completions API.`, {
                model: options.model,
                provider: 'openai',
            });
        }
    }
    buildHeaders() {
        return {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...(this.organization ? { 'OpenAI-Organization': this.organization } : {}),
            ...(this.project ? { 'OpenAI-Project': this.project } : {}),
        };
    }
}
export function translateOpenAIRequest(options) {
    const messages = [];
    if (options.system) {
        messages.push({
            content: options.system,
            role: 'developer',
        });
    }
    for (const message of options.messages) {
        if (message.role === 'system') {
            messages.push(translateOpenAISystemMessage(message));
            continue;
        }
        messages.push(...translateOpenAIMessage(message));
    }
    const body = {
        messages,
        model: options.model,
    };
    if (options.maxTokens !== undefined) {
        body.max_completion_tokens = options.maxTokens;
    }
    if (options.temperature !== undefined) {
        body.temperature = options.temperature;
    }
    if (options.tools && options.tools.length > 0) {
        body.tools = options.tools.map(translateOpenAITool);
    }
    if (options.toolChoice) {
        const mappedChoice = translateOpenAIToolChoice(options.toolChoice);
        body.tool_choice = mappedChoice.toolChoice;
        if (mappedChoice.parallelToolCalls !== undefined) {
            body.parallel_tool_calls = mappedChoice.parallelToolCalls;
        }
    }
    return body;
}
export function translateOpenAITool(tool) {
    return {
        function: {
            description: tool.description,
            name: tool.name,
            parameters: tool.parameters,
        },
        type: 'function',
    };
}
export function translateOpenAIToolChoice(toolChoice) {
    if (toolChoice.type === 'any') {
        return {
            toolChoice: 'required',
        };
    }
    if (toolChoice.type === 'tool') {
        return {
            ...(toolChoice.disableParallelToolUse !== undefined
                ? { parallelToolCalls: !toolChoice.disableParallelToolUse }
                : {}),
            toolChoice: {
                function: {
                    name: toolChoice.name,
                },
                type: 'function',
            },
        };
    }
    return {
        toolChoice: toolChoice.type,
    };
}
export function translateOpenAIResponse(payload, modelRegistry = new ModelRegistry(), requestedModel) {
    const resolvedModelId = resolveOpenAIModelId(payload.model, requestedModel, modelRegistry);
    const model = modelRegistry.get(resolvedModelId);
    const usage = usageWithCost(model, openaiUsageToCanonical(payload.usage));
    const choice = payload.choices[0];
    if (!choice) {
        throw new ProviderError('OpenAI response contained no choices.', {
            model: payload.model,
            provider: 'openai',
        });
    }
    const content = [];
    const toolCalls = [];
    if (choice.message.content) {
        content.push({
            text: choice.message.content,
            type: 'text',
        });
    }
    for (const toolCall of choice.message.tool_calls ?? []) {
        const args = parseOpenAIToolArguments(toolCall.function.arguments, payload.model, toolCall.function.name);
        content.push({
            args,
            id: toolCall.id,
            name: toolCall.function.name,
            type: 'tool_call',
        });
        toolCalls.push({
            args,
            id: toolCall.id,
            name: toolCall.function.name,
        });
    }
    return {
        content,
        finishReason: normalizeOpenAIFinishReason(choice.finish_reason),
        model: resolvedModelId,
        provider: 'openai',
        raw: payload,
        text: choice.message.content ?? '',
        toolCalls,
        usage,
    };
}
function resolveOpenAIModelId(responseModel, requestedModel, modelRegistry) {
    if (modelRegistry.isSupported(responseModel)) {
        return responseModel;
    }
    if (requestedModel && modelRegistry.isSupported(requestedModel)) {
        return requestedModel;
    }
    return responseModel;
}
export async function mapOpenAIError(response, model) {
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
    let body;
    try {
        body = (await response.json());
    }
    catch {
        body = undefined;
    }
    const message = body?.error?.message ?? `OpenAI request failed with ${response.status}.`;
    const code = body?.error?.code ?? undefined;
    const options = buildOpenAIErrorOptions(response.status, model, requestId, response.status === 429 || response.status >= 500);
    if (response.status === 401 || response.status === 403) {
        return new AuthenticationError(message, options);
    }
    if (response.status === 429) {
        return new RateLimitError(message, options);
    }
    if (response.status === 400 &&
        (code === 'context_length_exceeded' || /context|token/i.test(message))) {
        return new ContextLimitError(message, {
            ...options,
            retryable: false,
        });
    }
    return new ProviderError(message, options);
}
class OpenAIStreamAssembler {
    finishReason = 'stop';
    model;
    modelRegistry;
    toolBuffer = new Map();
    usage;
    constructor(model, modelRegistry) {
        this.model = model;
        this.modelRegistry = modelRegistry;
    }
    *consume(chunk) {
        if (chunk.usage) {
            this.usage = chunk.usage;
        }
        for (const choice of chunk.choices) {
            if (choice.delta.content) {
                yield {
                    delta: choice.delta.content,
                    type: 'text-delta',
                };
            }
            for (const toolCall of choice.delta.tool_calls ?? []) {
                const current = this.toolBuffer.get(toolCall.index);
                if (!current) {
                    const id = toolCall.id ?? `tool_call_${toolCall.index}`;
                    const name = toolCall.function?.name ?? `tool_${toolCall.index}`;
                    this.toolBuffer.set(toolCall.index, {
                        args: '',
                        id,
                        name,
                    });
                    yield {
                        id,
                        name,
                        type: 'tool-call-start',
                    };
                }
                else {
                    if (toolCall.id) {
                        current.id = toolCall.id;
                    }
                    if (toolCall.function?.name) {
                        current.name = toolCall.function.name;
                    }
                }
                if (toolCall.function?.arguments) {
                    const buffer = this.toolBuffer.get(toolCall.index);
                    if (!buffer) {
                        continue;
                    }
                    buffer.args += toolCall.function.arguments;
                    yield {
                        argsDelta: toolCall.function.arguments,
                        id: buffer.id,
                        type: 'tool-call-delta',
                    };
                }
            }
            if (choice.finish_reason) {
                this.finishReason = normalizeOpenAIFinishReason(choice.finish_reason);
                if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
                    yield* this.flushToolCalls();
                }
            }
        }
    }
    finish() {
        const model = this.modelRegistry.get(this.model);
        return {
            finishReason: this.finishReason,
            type: 'done',
            usage: usageWithCost(model, openaiUsageToCanonical(this.usage)),
        };
    }
    *flushToolCalls() {
        for (const [index, tool] of this.toolBuffer.entries()) {
            this.toolBuffer.delete(index);
            yield {
                id: tool.id,
                name: tool.name,
                result: parseOpenAIToolArguments(tool.args, this.model, tool.name),
                type: 'tool-call-result',
            };
        }
    }
}
function translateOpenAISystemMessage(message) {
    if (typeof message.content === 'string') {
        return {
            content: message.content,
            role: 'developer',
        };
    }
    if (message.content.some((part) => part.type !== 'text')) {
        throw new ProviderCapabilityError('OpenAI developer messages currently support text content only.', {
            provider: 'openai',
        });
    }
    const textParts = message.content.filter((part) => part.type === 'text');
    return {
        content: textParts.map((part) => part.text).join('\n\n'),
        role: 'developer',
    };
}
function translateOpenAIMessage(message) {
    switch (message.role) {
        case 'assistant':
            return translateOpenAIAssistantMessage(message);
        case 'system':
            return [translateOpenAISystemMessage(message)];
        case 'user':
            return translateOpenAIUserMessage(message);
    }
}
function translateOpenAIUserMessage(message) {
    if (typeof message.content === 'string') {
        return [
            {
                content: message.content,
                role: 'user',
            },
        ];
    }
    const userParts = [];
    const toolMessages = [];
    for (const part of message.content) {
        switch (part.type) {
            case 'audio':
            case 'document':
                throw new ProviderCapabilityError('OpenAI chat completions do not support document or audio canonical parts in this adapter.', {
                    provider: 'openai',
                });
            case 'image_base64':
                userParts.push({
                    image_url: {
                        url: `data:${part.mediaType};base64,${part.data}`,
                    },
                    type: 'image_url',
                });
                break;
            case 'image_url':
                userParts.push({
                    image_url: {
                        url: part.url,
                    },
                    type: 'image_url',
                });
                break;
            case 'text':
                userParts.push({
                    text: part.text,
                    type: 'text',
                });
                break;
            case 'tool_call':
                throw new ProviderCapabilityError('OpenAI tool calls must appear in assistant messages.', {
                    provider: 'openai',
                });
            case 'tool_result':
                toolMessages.push({
                    content: stringifyToolResult(part.result),
                    role: 'tool',
                    tool_call_id: part.toolCallId,
                });
                break;
        }
    }
    const messages = [];
    if (userParts.length > 0) {
        const onlyText = userParts.every((part) => part.type === 'text');
        messages.push({
            content: onlyText
                ? userParts.map((part) => part.text).join('\n\n')
                : userParts,
            role: 'user',
        });
    }
    messages.push(...toolMessages);
    return messages;
}
function translateOpenAIAssistantMessage(message) {
    if (typeof message.content === 'string') {
        return [
            {
                content: message.content,
                role: 'assistant',
            },
        ];
    }
    const textParts = [];
    const toolCalls = [];
    for (const part of message.content) {
        switch (part.type) {
            case 'audio':
            case 'document':
            case 'image_base64':
            case 'image_url':
            case 'tool_result':
                throw new ProviderCapabilityError('Assistant messages in the OpenAI adapter support text and tool-call parts only.', {
                    provider: 'openai',
                });
            case 'text':
                textParts.push(part.text);
                break;
            case 'tool_call':
                toolCalls.push({
                    function: {
                        arguments: JSON.stringify(part.args),
                        name: part.name,
                    },
                    id: part.id,
                    type: 'function',
                });
                break;
        }
    }
    if (toolCalls.length > 0) {
        return [
            {
                content: null,
                role: 'assistant',
                tool_calls: toolCalls,
            },
        ];
    }
    return [
        {
            content: textParts.join('\n\n'),
            role: 'assistant',
        },
    ];
}
function parseOpenAIToolArguments(argumentsJson, model, toolName) {
    try {
        const parsed = JSON.parse(argumentsJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Parsed tool arguments were not an object.');
        }
        return parsed;
    }
    catch (error) {
        throw new ProviderError(`Failed to parse OpenAI tool arguments for "${toolName}".`, {
            cause: error,
            model,
            provider: 'openai',
        });
    }
}
function normalizeOpenAIFinishReason(finishReason) {
    switch (finishReason) {
        case 'content_filter':
            return 'content_filter';
        case 'function_call':
        case 'tool_calls':
            return 'tool_call';
        case 'length':
            return 'length';
        case 'stop':
        case null:
            return 'stop';
    }
}
function messageContainsUnsupportedOpenAIParts(message) {
    return (typeof message.content !== 'string' &&
        message.content.some((part) => part.type === 'audio' || part.type === 'document'));
}
function messageContainsVisionContent(message) {
    return (typeof message.content !== 'string' &&
        message.content.some((part) => part.type === 'image_base64' || part.type === 'image_url'));
}
function buildOpenAIErrorOptions(statusCode, model, requestId, retryable) {
    return {
        provider: 'openai',
        retryable,
        statusCode,
        ...(model !== undefined ? { model } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
    };
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
function stringifyToolResult(result) {
    return typeof result === 'string' ? result : JSON.stringify(result);
}
