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
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1/responses`, buildRequestInit({
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
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1/responses`, buildRequestInit({
            body: JSON.stringify({
                ...translateOpenAIRequest(options),
                stream: true,
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
            const event = JSON.parse(payload);
            yield* assembler.consume(event);
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
            throw new ProviderCapabilityError(`Model "${options.model}" request includes unsupported content parts for the OpenAI Responses API.`, {
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
    const input = [];
    const instructions = [];
    if (options.system) {
        instructions.push(options.system);
    }
    for (const message of options.messages) {
        if (message.role === 'system') {
            instructions.push(translateOpenAISystemMessage(message));
            continue;
        }
        input.push(...translateOpenAIMessage(message));
    }
    const body = {
        input,
        model: options.model,
        store: false,
    };
    if (instructions.length > 0) {
        body.instructions = instructions.join('\n\n');
    }
    if (options.maxTokens !== undefined) {
        body.max_output_tokens = options.maxTokens;
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
        description: tool.description,
        name: tool.name,
        parameters: tool.parameters,
        strict: false,
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
                name: toolChoice.name,
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
    const content = [];
    const toolCalls = [];
    const textSegments = [];
    for (const item of payload.output ?? []) {
        if (isOpenAIMessageOutput(item) && item.role === 'assistant') {
            for (const part of item.content) {
                if (isOpenAIOutputTextPart(part)) {
                    content.push({
                        text: part.text,
                        type: 'text',
                    });
                    textSegments.push(part.text);
                    continue;
                }
                if (isOpenAIRefusalPart(part)) {
                    content.push({
                        text: part.refusal,
                        type: 'text',
                    });
                    textSegments.push(part.refusal);
                }
            }
            continue;
        }
        if (isOpenAIFunctionCallOutput(item)) {
            const args = parseOpenAIToolArguments(item.arguments, payload.model, item.name);
            content.push({
                args,
                id: item.call_id,
                name: item.name,
                type: 'tool_call',
            });
            toolCalls.push({
                args,
                id: item.call_id,
                name: item.name,
            });
        }
    }
    return {
        content,
        finishReason: normalizeOpenAIFinishReason(payload),
        model: resolvedModelId,
        provider: 'openai',
        raw: payload,
        text: textSegments.join(''),
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
    finalResponse;
    finishReason = 'stop';
    model;
    modelRegistry;
    toolBuffer = new Map();
    constructor(model, modelRegistry) {
        this.model = model;
        this.modelRegistry = modelRegistry;
    }
    *consume(event) {
        switch (event.type) {
            case 'response.output_text.delta': {
                const typedEvent = event;
                if (typedEvent.delta.length > 0) {
                    yield {
                        delta: typedEvent.delta,
                        type: 'text-delta',
                    };
                }
                return;
            }
            case 'response.output_item.added': {
                const typedEvent = event;
                yield* this.handleOutputItemAdded(typedEvent.item, typedEvent.output_index);
                return;
            }
            case 'response.function_call_arguments.delta':
                yield* this.handleFunctionCallArgumentsDelta(event);
                return;
            case 'response.function_call_arguments.done':
                this.handleFunctionCallArgumentsDone(event);
                return;
            case 'response.output_item.done': {
                const typedEvent = event;
                yield* this.handleOutputItemDone(typedEvent.item, typedEvent.output_index);
                return;
            }
            case 'response.completed':
            case 'response.incomplete':
                this.finalResponse = event.response;
                this.finishReason = normalizeOpenAIFinishReason(this.finalResponse);
                return;
            case 'response.failed':
                this.finalResponse = event.response;
                this.finishReason = normalizeOpenAIFinishReason(this.finalResponse);
                throw this.buildStreamError(this.finalResponse.error);
            case 'error':
                throw this.buildStreamError(event);
            default:
                return;
        }
    }
    finish() {
        const responseModel = this.finalResponse?.model ?? this.model;
        const resolvedModelId = resolveOpenAIModelId(responseModel, this.model, this.modelRegistry);
        const model = this.modelRegistry.get(resolvedModelId);
        return {
            finishReason: this.finishReason,
            type: 'done',
            usage: usageWithCost(model, openaiUsageToCanonical(this.finalResponse?.usage)),
        };
    }
    buildStreamError(error) {
        return new ProviderError(error?.message ?? 'OpenAI streaming request failed.', {
            model: this.model,
            provider: 'openai',
        });
    }
    *handleOutputItemAdded(item, outputIndex) {
        if (!isOpenAIFunctionCallOutput(item)) {
            return;
        }
        const existing = this.toolBuffer.get(item.id);
        if (existing) {
            existing.callId = item.call_id;
            existing.name = item.name;
            if (item.arguments.length > existing.args.length) {
                existing.args = item.arguments;
            }
            return;
        }
        this.toolBuffer.set(item.id, {
            args: item.arguments,
            callId: item.call_id,
            name: item.name,
        });
        yield {
            id: item.call_id,
            name: item.name,
            type: 'tool-call-start',
        };
        if (item.arguments.length > 0) {
            yield {
                argsDelta: item.arguments,
                id: item.call_id,
                type: 'tool-call-delta',
            };
        }
        void outputIndex;
    }
    *handleFunctionCallArgumentsDelta(event) {
        const tool = this.getOrCreateToolBuffer(event.item_id, event.output_index);
        tool.args += event.delta;
        yield {
            argsDelta: event.delta,
            id: tool.callId,
            type: 'tool-call-delta',
        };
    }
    handleFunctionCallArgumentsDone(event) {
        const tool = this.getOrCreateToolBuffer(event.item_id, event.output_index);
        tool.args = event.arguments;
        tool.name = event.name;
        if (event.call_id) {
            tool.callId = event.call_id;
        }
    }
    *handleOutputItemDone(item, outputIndex) {
        if (!isOpenAIFunctionCallOutput(item)) {
            return;
        }
        const tool = this.getOrCreateToolBuffer(item.id, outputIndex);
        tool.args = item.arguments;
        tool.callId = item.call_id;
        tool.name = item.name;
        this.toolBuffer.delete(item.id);
        this.finishReason = 'tool_call';
        yield {
            id: tool.callId,
            name: tool.name,
            result: parseOpenAIToolArguments(tool.args, this.model, tool.name),
            type: 'tool-call-result',
        };
    }
    getOrCreateToolBuffer(itemId, outputIndex) {
        const existing = this.toolBuffer.get(itemId);
        if (existing) {
            return existing;
        }
        const created = {
            args: '',
            callId: itemId,
            name: `tool_${outputIndex}`,
        };
        this.toolBuffer.set(itemId, created);
        return created;
    }
}
function translateOpenAISystemMessage(message) {
    if (typeof message.content === 'string') {
        return message.content;
    }
    if (message.content.some((part) => part.type !== 'text')) {
        throw new ProviderCapabilityError('OpenAI instructions currently support text content only.', {
            provider: 'openai',
        });
    }
    const textParts = message.content.filter((part) => part.type === 'text');
    return textParts.map((part) => part.text).join('\n\n');
}
function translateOpenAIMessage(message) {
    switch (message.role) {
        case 'assistant':
            return translateOpenAIAssistantMessage(message);
        case 'system':
            return [];
        case 'user':
            return translateOpenAIUserMessage(message);
    }
}
function translateOpenAIUserMessage(message) {
    if (typeof message.content === 'string') {
        return [
            {
                content: [
                    {
                        text: message.content,
                        type: 'input_text',
                    },
                ],
                role: 'user',
                type: 'message',
            },
        ];
    }
    const userParts = [];
    const items = [];
    for (const part of message.content) {
        switch (part.type) {
            case 'audio':
            case 'document':
                throw new ProviderCapabilityError('OpenAI Responses do not support document or audio canonical parts in this adapter.', {
                    provider: 'openai',
                });
            case 'image_base64':
                userParts.push({
                    image_url: `data:${part.mediaType};base64,${part.data}`,
                    type: 'input_image',
                });
                break;
            case 'image_url':
                userParts.push({
                    image_url: part.url,
                    type: 'input_image',
                });
                break;
            case 'text':
                userParts.push({
                    text: part.text,
                    type: 'input_text',
                });
                break;
            case 'tool_call':
                throw new ProviderCapabilityError('OpenAI tool calls must appear in assistant messages.', {
                    provider: 'openai',
                });
            case 'tool_result':
                items.push({
                    call_id: part.toolCallId,
                    output: stringifyToolResult(part.result),
                    type: 'function_call_output',
                });
                break;
        }
    }
    if (userParts.length > 0) {
        items.unshift({
            content: userParts,
            role: 'user',
            type: 'message',
        });
    }
    return items;
}
function translateOpenAIAssistantMessage(message) {
    if (typeof message.content === 'string') {
        return [
            {
                content: [
                    {
                        text: message.content,
                        type: 'input_text',
                    },
                ],
                role: 'assistant',
                type: 'message',
            },
        ];
    }
    const items = [];
    const textParts = [];
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
                textParts.push({
                    text: part.text,
                    type: 'input_text',
                });
                break;
            case 'tool_call':
                items.push({
                    arguments: JSON.stringify(part.args),
                    call_id: part.id,
                    name: part.name,
                    type: 'function_call',
                });
                break;
        }
    }
    if (textParts.length > 0) {
        items.unshift({
            content: textParts,
            role: 'assistant',
            type: 'message',
        });
    }
    return items;
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
function normalizeOpenAIFinishReason(payload) {
    if ((payload.output ?? []).some(isOpenAIFunctionCallOutput)) {
        return 'tool_call';
    }
    if (payload.error || payload.status === 'failed') {
        return 'error';
    }
    const reason = payload.incomplete_details?.reason ?? '';
    if (reason.length > 0) {
        if (/content|filter|policy|safety/i.test(reason)) {
            return 'content_filter';
        }
        if (/length|max|token/i.test(reason)) {
            return 'length';
        }
    }
    if (payload.status === 'incomplete') {
        return 'length';
    }
    return 'stop';
}
function isOpenAIFunctionCallOutput(item) {
    return item.type === 'function_call';
}
function isOpenAIMessageOutput(item) {
    return item.type === 'message';
}
function isOpenAIOutputTextPart(part) {
    return part.type === 'output_text';
}
function isOpenAIRefusalPart(part) {
    return part.type === 'refusal';
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
