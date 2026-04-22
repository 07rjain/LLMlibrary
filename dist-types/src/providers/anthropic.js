import { AuthenticationError, ContextLimitError, ProviderCapabilityError, ProviderError, RateLimitError, } from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import { anthropicUsageToCanonical, usageWithCost } from '../utils/cost.js';
import { parseSSE } from '../utils/parse-sse.js';
import { withRetry } from '../utils/retry.js';
export class AnthropicAdapter {
    apiKey;
    baseUrl;
    fetchImplementation;
    modelRegistry;
    retryOptions;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
        this.fetchImplementation = config.fetchImplementation ?? fetch;
        this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
        this.retryOptions = config.retryOptions;
    }
    async complete(options) {
        this.assertCapabilities(options);
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1/messages`, buildRequestInit({
            body: JSON.stringify(translateAnthropicRequest(options)),
            headers: this.buildHeaders(),
            method: 'POST',
        }, options.signal)), this.retryOptions);
        if (!response.ok) {
            throw await mapAnthropicError(response, options.model);
        }
        const payload = (await response.json());
        return translateAnthropicResponse(payload, this.modelRegistry, options.model);
    }
    async *stream(options) {
        this.assertCapabilities({ ...options, stream: true });
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1/messages`, buildRequestInit({
            body: JSON.stringify({
                ...translateAnthropicRequest(options),
                stream: true,
            }),
            headers: this.buildHeaders(),
            method: 'POST',
        }, options.signal)), this.retryOptions);
        if (!response.ok) {
            throw await mapAnthropicError(response, options.model);
        }
        if (!response.body) {
            throw new ProviderError('Anthropic streaming response did not include a body.', {
                model: options.model,
                provider: 'anthropic',
            });
        }
        const assembler = new AnthropicStreamAssembler(options.model, this.modelRegistry);
        for await (const payload of parseSSE(response.body)) {
            const event = JSON.parse(payload);
            yield* assembler.consume(event);
        }
        const doneChunk = assembler.finish();
        if (doneChunk) {
            yield doneChunk;
        }
    }
    async listModels() {
        const models = [];
        let afterId;
        while (true) {
            const searchParams = new URLSearchParams({
                limit: '100',
            });
            if (afterId) {
                searchParams.set('after_id', afterId);
            }
            const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1/models?${searchParams.toString()}`, buildRequestInit({
                headers: this.buildHeaders(),
                method: 'GET',
            }, undefined)), this.retryOptions);
            if (!response.ok) {
                throw await mapAnthropicError(response);
            }
            const payload = (await response.json());
            for (const model of payload.data ?? []) {
                models.push({
                    ...(model.created_at ? { createdAt: model.created_at } : {}),
                    ...(model.display_name ? { displayName: model.display_name } : {}),
                    id: model.id,
                    provider: 'anthropic',
                    raw: model,
                });
            }
            const lastId = payload.last_id ?? payload.data?.at(-1)?.id;
            if (!payload.has_more || !lastId) {
                return models;
            }
            afterId = lastId;
        }
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
        if (options.messages.some(messageContainsAudio)) {
            throw new ProviderCapabilityError(`Model "${options.model}" does not support audio input through Anthropic messages.`, {
                model: options.model,
                provider: 'anthropic',
            });
        }
    }
    buildHeaders() {
        return {
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
        };
    }
}
export function translateAnthropicRequest(options) {
    const systemMessages = options.messages.filter((message) => message.role === 'system');
    const nonSystemMessages = options.messages.filter((message) => message.role !== 'system');
    const cacheControl = options.providerOptions?.anthropic?.cacheControl;
    const body = {
        max_tokens: options.maxTokens,
        messages: nonSystemMessages.map(translateAnthropicMessage),
        model: options.model,
    };
    const system = translateAnthropicSystemPrompt(systemMessages, options.system);
    if (system !== undefined) {
        body.system = system;
    }
    if (options.temperature !== undefined) {
        body.temperature = options.temperature;
    }
    if (options.tools && options.tools.length > 0) {
        body.tools = options.tools.map(translateAnthropicTool);
    }
    if (options.toolChoice) {
        body.tool_choice = translateAnthropicToolChoice(options.toolChoice);
    }
    if (cacheControl) {
        body.cache_control = cacheControl;
    }
    return body;
}
export function translateAnthropicTool(tool) {
    return {
        ...(tool.cacheControl !== undefined ? { cache_control: tool.cacheControl } : {}),
        description: tool.description,
        input_schema: tool.parameters,
        name: tool.name,
    };
}
export function translateAnthropicToolChoice(toolChoice) {
    if (toolChoice.type === 'tool') {
        const mappedChoice = {
            name: toolChoice.name,
            type: 'tool',
        };
        if (toolChoice.disableParallelToolUse !== undefined) {
            mappedChoice.disable_parallel_tool_use = toolChoice.disableParallelToolUse;
        }
        return mappedChoice;
    }
    return toolChoice;
}
export function translateAnthropicResponse(payload, modelRegistry = new ModelRegistry(), requestedModel) {
    const resolvedModelId = resolveAnthropicModelId(payload.model, requestedModel, modelRegistry);
    const model = modelRegistry.get(resolvedModelId);
    const usage = usageWithCost(model, anthropicUsageToCanonical(payload.usage));
    const toolCalls = [];
    const content = [];
    let text = '';
    for (const block of payload.content) {
        if (block.type === 'text') {
            content.push(buildCanonicalTextPart(block.text, block.cache_control));
            text += block.text;
            continue;
        }
        if (block.type === 'tool_use') {
            toolCalls.push({
                args: block.input,
                id: block.id,
                name: block.name,
            });
            content.push({
                args: block.input,
                id: block.id,
                name: block.name,
                type: 'tool_call',
            });
        }
    }
    return {
        content,
        finishReason: normalizeAnthropicFinishReason(payload.stop_reason),
        model: resolvedModelId,
        provider: 'anthropic',
        raw: payload,
        text,
        toolCalls,
        usage,
    };
}
function resolveAnthropicModelId(responseModel, requestedModel, modelRegistry) {
    if (modelRegistry.isSupported(responseModel)) {
        return responseModel;
    }
    if (requestedModel &&
        modelRegistry.isSupported(requestedModel) &&
        responseModel.startsWith(`${requestedModel}-`)) {
        return requestedModel;
    }
    return responseModel;
}
export async function mapAnthropicError(response, model) {
    const requestId = response.headers.get('anthropic-request-id') ?? response.headers.get('request-id') ?? undefined;
    let body;
    try {
        body = (await response.json());
    }
    catch {
        body = undefined;
    }
    const message = body?.error?.message ?? `Anthropic request failed with ${response.status}.`;
    const type = body?.error?.type;
    const baseOptions = buildAnthropicErrorOptions(response.status, model, requestId, response.status === 429 || response.status >= 500);
    if (response.status === 401 || response.status === 403) {
        return new AuthenticationError(message, baseOptions);
    }
    if (response.status === 429) {
        return new RateLimitError(message, baseOptions);
    }
    if (response.status === 400 &&
        (type === 'invalid_request_error' || type === 'context_limit_error') &&
        /context|token/i.test(message)) {
        return new ContextLimitError(message, {
            ...baseOptions,
            retryable: false,
        });
    }
    return new ProviderError(message, baseOptions);
}
class AnthropicStreamAssembler {
    finishReason = 'stop';
    model;
    modelRegistry;
    toolBuffer = new Map();
    usage = {};
    constructor(model, modelRegistry) {
        this.model = model;
        this.modelRegistry = modelRegistry;
    }
    *consume(event) {
        switch (event.type) {
            case 'message_start':
                this.usage = event.message?.usage ?? {};
                return;
            case 'content_block_start':
                if (event.content_block?.type === 'tool_use' &&
                    event.index !== undefined) {
                    this.toolBuffer.set(event.index, {
                        id: event.content_block.id,
                        json: '',
                        name: event.content_block.name,
                    });
                    yield {
                        id: event.content_block.id,
                        name: event.content_block.name,
                        type: 'tool-call-start',
                    };
                }
                return;
            case 'content_block_delta':
                if (event.delta?.type === 'text_delta' && event.delta.text) {
                    yield {
                        delta: event.delta.text,
                        type: 'text-delta',
                    };
                    return;
                }
                if (event.delta?.type === 'input_json_delta' &&
                    event.delta.partial_json &&
                    event.index !== undefined) {
                    const current = this.toolBuffer.get(event.index);
                    if (current) {
                        current.json += event.delta.partial_json;
                        yield {
                            argsDelta: event.delta.partial_json,
                            id: current.id,
                            type: 'tool-call-delta',
                        };
                    }
                }
                return;
            case 'content_block_stop':
                if (event.index === undefined) {
                    return;
                }
                yield* this.flushToolCall(event.index);
                return;
            case 'message_delta':
                this.finishReason = normalizeAnthropicFinishReason(event.delta?.stop_reason ?? 'end_turn');
                this.usage = {
                    ...this.usage,
                    ...event.usage,
                };
                return;
            case 'message_stop':
                return;
        }
    }
    finish() {
        const modelInfo = this.modelRegistry.get(this.model);
        return {
            finishReason: this.finishReason,
            type: 'done',
            usage: usageWithCost(modelInfo, anthropicUsageToCanonical(this.usage)),
        };
    }
    *flushToolCall(index) {
        const tool = this.toolBuffer.get(index);
        if (!tool) {
            return;
        }
        this.toolBuffer.delete(index);
        const parsed = tool.json ? JSON.parse(tool.json) : {};
        yield {
            id: tool.id,
            name: tool.name,
            result: parsed,
            type: 'tool-call-result',
        };
    }
}
function translateAnthropicMessage(message) {
    if (message.role === 'system') {
        throw new ProviderCapabilityError('System messages must be lifted into the top-level Anthropic system field.', {
            provider: 'anthropic',
        });
    }
    const role = message.role;
    return {
        content: typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => translateAnthropicPart(role, part)),
        role,
    };
}
function translateAnthropicPart(role, part) {
    switch (part.type) {
        case 'audio': {
            throw new ProviderCapabilityError('Anthropic does not support audio parts.', {
                provider: 'anthropic',
            });
        }
        case 'document': {
            if (part.url) {
                const documentBlock = {
                    ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
                    source: {
                        type: 'url',
                        url: part.url,
                    },
                    type: 'document',
                };
                if (part.title !== undefined) {
                    documentBlock.title = part.title;
                }
                return documentBlock;
            }
            if (!part.data) {
                throw new ProviderCapabilityError('Anthropic documents require data or a URL.', {
                    provider: 'anthropic',
                });
            }
            const documentBlock = {
                ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
                source: {
                    data: part.data,
                    media_type: part.mediaType,
                    type: 'base64',
                },
                type: 'document',
            };
            if (part.title !== undefined) {
                documentBlock.title = part.title;
            }
            return documentBlock;
        }
        case 'image_base64': {
            return {
                ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
                source: {
                    data: part.data,
                    media_type: part.mediaType,
                    type: 'base64',
                },
                type: 'image',
            };
        }
        case 'image_url': {
            return {
                ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
                source: {
                    type: 'url',
                    url: part.url,
                },
                type: 'image',
            };
        }
        case 'text': {
            return buildAnthropicTextBlock(part.text, part.cacheControl);
        }
        case 'tool_call': {
            if (role !== 'assistant') {
                throw new ProviderCapabilityError('Anthropic tool calls must appear in assistant messages.', {
                    provider: 'anthropic',
                });
            }
            return {
                ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
                id: part.id,
                input: part.args,
                name: part.name,
                type: 'tool_use',
            };
        }
        case 'tool_result': {
            if (role !== 'user') {
                throw new ProviderCapabilityError('Anthropic tool results must appear in user messages.', {
                    provider: 'anthropic',
                });
            }
            const toolResultBlock = {
                ...(part.cacheControl !== undefined ? { cache_control: part.cacheControl } : {}),
                content: stringifyToolResult(part.result),
                tool_use_id: part.toolCallId,
                type: 'tool_result',
            };
            if (part.isError !== undefined) {
                toolResultBlock.is_error = part.isError;
            }
            return toolResultBlock;
        }
    }
}
function translateAnthropicSystemPrompt(systemMessages, explicitSystem) {
    if (explicitSystem && systemMessages.length === 0) {
        return explicitSystem;
    }
    if (systemMessages.length === 0) {
        return undefined;
    }
    const parts = systemMessages.flatMap((message) => {
        if (typeof message.content === 'string') {
            return [buildAnthropicTextBlock(message.content)];
        }
        return message.content.map((part) => {
            if (part.type !== 'text') {
                throw new ProviderCapabilityError('Anthropic system prompts currently support text content only.', {
                    provider: 'anthropic',
                });
            }
            return buildAnthropicTextBlock(part.text, part.cacheControl);
        });
    });
    if (explicitSystem) {
        parts.unshift(buildAnthropicTextBlock(explicitSystem));
    }
    return parts.every((part) => !part.cache_control)
        ? parts.map((part) => part.text).join('\n\n')
        : parts;
}
function normalizeAnthropicFinishReason(finishReason) {
    switch (finishReason) {
        case 'max_tokens':
            return 'length';
        case 'tool_use':
            return 'tool_call';
        case 'end_turn':
        case 'stop_sequence':
        case null:
            return 'stop';
    }
}
function messageContainsAudio(message) {
    return (typeof message.content !== 'string' &&
        message.content.some((part) => part.type === 'audio'));
}
function messageContainsVisionContent(message) {
    return (typeof message.content !== 'string' &&
        message.content.some((part) => part.type === 'image_base64' || part.type === 'image_url'));
}
function stringifyToolResult(result) {
    return typeof result === 'string' ? result : JSON.stringify(result);
}
function buildAnthropicErrorOptions(statusCode, model, requestId, retryable) {
    const options = {
        provider: 'anthropic',
        retryable,
        statusCode,
    };
    return {
        ...options,
        ...(model !== undefined ? { model } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
    };
}
function buildAnthropicTextBlock(text, cacheControl) {
    return {
        text,
        type: 'text',
        ...(cacheControl !== undefined ? { cache_control: cacheControl } : {}),
    };
}
function buildCanonicalTextPart(text, cacheControl) {
    return {
        text,
        type: 'text',
        ...(cacheControl !== undefined ? { cacheControl } : {}),
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
