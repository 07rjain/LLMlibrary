import { AuthenticationError, ContextLimitError, ProviderCapabilityError, ProviderError, RateLimitError, } from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import { geminiUsageToCanonical, usageWithCost } from '../utils/cost.js';
import { parseSSE } from '../utils/parse-sse.js';
import { withRetry } from '../utils/retry.js';
export class GeminiAdapter {
    apiKey;
    baseUrl;
    fetchImplementation;
    modelRegistry;
    retryOptions;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com';
        this.fetchImplementation = config.fetchImplementation ?? fetch;
        this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
        this.retryOptions = config.retryOptions;
    }
    async complete(options) {
        this.assertCapabilities(options);
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`, buildRequestInit({
            body: JSON.stringify(translateGeminiRequest(options)),
            headers: this.buildHeaders(),
            method: 'POST',
        }, options.signal)), this.retryOptions);
        if (!response.ok) {
            throw await mapGeminiError(response, options.model);
        }
        const payload = (await response.json());
        return translateGeminiResponse(payload, options.model, this.modelRegistry);
    }
    async *stream(options) {
        this.assertCapabilities({ ...options, stream: true });
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`, buildRequestInit({
            body: JSON.stringify(translateGeminiRequest(options)),
            headers: this.buildHeaders(),
            method: 'POST',
        }, options.signal)), this.retryOptions);
        if (!response.ok) {
            throw await mapGeminiError(response, options.model);
        }
        if (!response.body) {
            throw new ProviderError('Gemini streaming response did not include a body.', {
                model: options.model,
                provider: 'google',
            });
        }
        const assembler = new GeminiStreamAssembler(options.model, this.modelRegistry);
        for await (const payload of parseSSE(response.body)) {
            const chunk = JSON.parse(payload);
            yield* assembler.consume(chunk);
        }
        yield assembler.finish();
    }
    async createCache(options) {
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/cachedContents`, buildRequestInit({
            body: JSON.stringify(translateGeminiCacheCreateRequest(options)),
            headers: this.buildHeaders(),
            method: 'POST',
        }, undefined)), this.retryOptions);
        if (!response.ok) {
            throw await mapGeminiError(response, options.model);
        }
        return (await response.json());
    }
    async getCache(name) {
        const normalizedName = normalizeGeminiCachedContentName(name);
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/${normalizedName}`, buildRequestInit({
            headers: this.buildHeaders(),
            method: 'GET',
        }, undefined)), this.retryOptions);
        if (!response.ok) {
            throw await mapGeminiError(response);
        }
        return (await response.json());
    }
    async listCaches(options = {}) {
        const searchParams = new URLSearchParams();
        if (options.pageSize !== undefined) {
            searchParams.set('pageSize', String(options.pageSize));
        }
        if (options.pageToken) {
            searchParams.set('pageToken', options.pageToken);
        }
        const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : '';
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/cachedContents${suffix}`, buildRequestInit({
            headers: this.buildHeaders(),
            method: 'GET',
        }, undefined)), this.retryOptions);
        if (!response.ok) {
            throw await mapGeminiError(response);
        }
        return (await response.json());
    }
    async listModels() {
        const models = [];
        let pageToken;
        while (true) {
            const searchParams = new URLSearchParams({
                pageSize: '100',
            });
            if (pageToken) {
                searchParams.set('pageToken', pageToken);
            }
            const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/models?${searchParams.toString()}`, buildRequestInit({
                headers: this.buildHeaders(),
                method: 'GET',
            }, undefined)), this.retryOptions);
            if (!response.ok) {
                throw await mapGeminiError(response);
            }
            const payload = (await response.json());
            for (const model of payload.models ?? []) {
                models.push({
                    ...(model.displayName ? { displayName: model.displayName } : {}),
                    id: normalizeGeminiModelId(model.name),
                    ...(model.inputTokenLimit !== undefined
                        ? { inputTokenLimit: model.inputTokenLimit }
                        : {}),
                    ...(model.outputTokenLimit !== undefined
                        ? { outputTokenLimit: model.outputTokenLimit }
                        : {}),
                    provider: 'google',
                    providerId: model.name,
                    raw: model,
                    ...(model.supportedGenerationMethods
                        ? { supportedActions: model.supportedGenerationMethods }
                        : {}),
                });
            }
            if (!payload.nextPageToken) {
                return models;
            }
            pageToken = payload.nextPageToken;
        }
    }
    async updateCache(name, options) {
        const normalizedName = normalizeGeminiCachedContentName(name);
        const translated = translateGeminiCacheUpdateRequest(options);
        const searchParams = new URLSearchParams({
            updateMask: translated.updateMask,
        });
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/${normalizedName}?${searchParams.toString()}`, buildRequestInit({
            body: JSON.stringify(translated.body),
            headers: this.buildHeaders(),
            method: 'PATCH',
        }, undefined)), this.retryOptions);
        if (!response.ok) {
            throw await mapGeminiError(response);
        }
        return (await response.json());
    }
    async deleteCache(name) {
        const normalizedName = normalizeGeminiCachedContentName(name);
        const response = await withRetry(async () => this.fetchImplementation(`${this.baseUrl}/v1beta/${normalizedName}`, buildRequestInit({
            headers: this.buildHeaders(),
            method: 'DELETE',
        }, undefined)), this.retryOptions);
        if (!response.ok) {
            throw await mapGeminiError(response);
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
    }
    buildHeaders() {
        return {
            'content-type': 'application/json',
            'x-goog-api-key': this.apiKey,
        };
    }
}
export function translateGeminiRequest(options) {
    const systemMessages = options.messages.filter((message) => message.role === 'system');
    const nonSystemMessages = options.messages.filter((message) => message.role !== 'system');
    const cachedContent = options.providerOptions?.google?.promptCaching?.cachedContent;
    const body = {
        contents: nonSystemMessages.map(translateGeminiMessage),
    };
    const systemInstruction = translateGeminiSystemInstruction(systemMessages, options.system);
    if (systemInstruction) {
        body.systemInstruction = systemInstruction;
    }
    const generationConfig = {};
    if (options.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = options.maxTokens;
    }
    if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
    }
    if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig;
    }
    if (options.tools && options.tools.length > 0) {
        body.tools = [translateGeminiTools(options.tools)];
    }
    if (options.toolChoice) {
        body.toolConfig = translateGeminiToolChoice(options.toolChoice);
    }
    if (cachedContent) {
        body.cachedContent = cachedContent;
    }
    return body;
}
export function translateGeminiCacheCreateRequest(options) {
    const messages = options.messages ?? [];
    const systemMessages = messages.filter((message) => message.role === 'system');
    const nonSystemMessages = messages.filter((message) => message.role !== 'system');
    const body = {
        model: normalizeGeminiCacheModelName(options.model),
    };
    if (nonSystemMessages.length > 0) {
        body.contents = nonSystemMessages.map(translateGeminiMessage);
    }
    const systemInstruction = translateGeminiSystemInstruction(systemMessages, options.system);
    if (systemInstruction) {
        body.systemInstruction = systemInstruction;
    }
    if (options.tools && options.tools.length > 0) {
        body.tools = [translateGeminiTools(options.tools)];
    }
    if (options.toolChoice) {
        body.toolConfig = translateGeminiToolChoice(options.toolChoice);
    }
    if (options.displayName) {
        body.displayName = options.displayName;
    }
    applyGeminiCacheExpiration(body, options.ttl, options.expireTime);
    return body;
}
export function translateGeminiCacheUpdateRequest(options) {
    if (options.ttl && options.expireTime) {
        throw new ProviderError('Gemini cache updates accept either ttl or expireTime, not both.', {
            provider: 'google',
        });
    }
    if (options.ttl) {
        return {
            body: { ttl: options.ttl },
            updateMask: 'ttl',
        };
    }
    if (options.expireTime) {
        return {
            body: { expireTime: options.expireTime },
            updateMask: 'expireTime',
        };
    }
    throw new ProviderError('Gemini cache updates require ttl or expireTime.', {
        provider: 'google',
    });
}
export function translateGeminiTools(tools) {
    return {
        functionDeclarations: tools.map(translateGeminiTool),
    };
}
export function translateGeminiTool(tool) {
    return {
        description: tool.description,
        name: tool.name,
        parameters: translateGeminiSchema(tool.parameters),
    };
}
export function translateGeminiToolChoice(toolChoice) {
    if (toolChoice.type === 'tool') {
        return {
            functionCallingConfig: {
                allowedFunctionNames: [toolChoice.name],
                mode: 'ANY',
            },
        };
    }
    return {
        functionCallingConfig: {
            mode: toolChoice.type.toUpperCase(),
        },
    };
}
export function translateGeminiResponse(payload, requestedModel, modelRegistry = new ModelRegistry()) {
    const model = modelRegistry.get(requestedModel);
    const usage = usageWithCost(model, geminiUsageToCanonical(payload.usageMetadata));
    const candidate = payload.candidates?.[0];
    if (!candidate) {
        if (payload.promptFeedback?.blockReason) {
            return {
                content: [],
                finishReason: 'content_filter',
                model: requestedModel,
                provider: 'google',
                raw: payload,
                text: '',
                toolCalls: [],
                usage,
            };
        }
        throw new ProviderError('Gemini response contained no candidates.', {
            model: requestedModel,
            provider: 'google',
        });
    }
    const content = [];
    const toolCalls = [];
    let text = '';
    for (const [partIndex, part] of (candidate.content?.parts ?? []).entries()) {
        if ('text' in part) {
            content.push({
                text: part.text,
                type: 'text',
            });
            text += part.text;
            continue;
        }
        if ('functionCall' in part) {
            const id = buildGeminiToolCallId(candidate.index, partIndex, part.functionCall.name);
            content.push({
                args: part.functionCall.args,
                id,
                name: part.functionCall.name,
                type: 'tool_call',
            });
            toolCalls.push({
                args: part.functionCall.args,
                id,
                name: part.functionCall.name,
            });
        }
    }
    return {
        content,
        finishReason: normalizeGeminiFinishReason(candidate.finishReason ?? null, candidate.content?.parts ?? []),
        model: requestedModel,
        provider: 'google',
        raw: payload,
        text,
        toolCalls,
        usage,
    };
}
export async function mapGeminiError(response, model) {
    const requestId = response.headers.get('x-goog-request-id') ??
        response.headers.get('x-request-id') ??
        response.headers.get('request-id') ??
        undefined;
    let body;
    try {
        body = (await response.json());
    }
    catch {
        body = undefined;
    }
    const message = body?.error?.message ?? `Gemini request failed with ${response.status}.`;
    const status = body?.error?.status;
    const details = body?.error?.details;
    const baseOptions = buildGeminiErrorOptions(response.status, model, requestId, details, response.status === 429 || response.status >= 500);
    if (response.status === 401 ||
        response.status === 403 ||
        status === 'UNAUTHENTICATED' ||
        status === 'PERMISSION_DENIED') {
        return new AuthenticationError(message, baseOptions);
    }
    if (response.status === 429 || status === 'RESOURCE_EXHAUSTED') {
        return new RateLimitError(message, baseOptions);
    }
    if (response.status === 400 &&
        (status === 'INVALID_ARGUMENT' || /context|token/i.test(message))) {
        return new ContextLimitError(message, {
            ...baseOptions,
            retryable: false,
        });
    }
    return new ProviderError(message, baseOptions);
}
class GeminiStreamAssembler {
    emittedToolCalls = new Set();
    finishReason = 'stop';
    model;
    modelRegistry;
    usage;
    constructor(model, modelRegistry) {
        this.model = model;
        this.modelRegistry = modelRegistry;
    }
    *consume(chunk) {
        if (chunk.usageMetadata) {
            this.usage = chunk.usageMetadata;
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate) {
            if (chunk.promptFeedback?.blockReason) {
                this.finishReason = 'content_filter';
            }
            return;
        }
        const parts = candidate.content?.parts ?? [];
        for (const [partIndex, part] of parts.entries()) {
            if ('text' in part) {
                yield {
                    delta: part.text,
                    type: 'text-delta',
                };
                continue;
            }
            if ('functionCall' in part) {
                const id = buildGeminiToolCallId(candidate.index, partIndex, part.functionCall.name);
                if (this.emittedToolCalls.has(id)) {
                    continue;
                }
                this.emittedToolCalls.add(id);
                yield {
                    id,
                    name: part.functionCall.name,
                    type: 'tool-call-start',
                };
                yield {
                    id,
                    name: part.functionCall.name,
                    result: part.functionCall.args,
                    type: 'tool-call-result',
                };
            }
        }
        if (candidate.finishReason !== undefined) {
            this.finishReason = normalizeGeminiFinishReason(candidate.finishReason, parts);
        }
    }
    finish() {
        const model = this.modelRegistry.get(this.model);
        return {
            finishReason: this.finishReason,
            type: 'done',
            usage: usageWithCost(model, geminiUsageToCanonical(this.usage)),
        };
    }
}
function translateGeminiMessage(message) {
    if (message.role === 'system') {
        throw new ProviderCapabilityError('System messages must be lifted into Gemini systemInstruction.', {
            provider: 'google',
        });
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    return {
        parts: typeof message.content === 'string'
            ? [{ text: message.content }]
            : message.content.map((part) => translateGeminiPart(message.role === 'assistant' ? 'assistant' : 'user', part)),
        role,
    };
}
function translateGeminiPart(role, part) {
    switch (part.type) {
        case 'audio':
            return translateGeminiBinaryLikePart(part.data, part.mediaType, part.url, 'Gemini audio parts require data or a URL.');
        case 'document':
            return translateGeminiBinaryLikePart(part.data, part.mediaType, part.url, 'Gemini documents require data or a URL.');
        case 'image_base64':
            return {
                inlineData: {
                    data: part.data,
                    mimeType: part.mediaType,
                },
            };
        case 'image_url':
            return {
                fileData: {
                    fileUri: part.url,
                    mimeType: part.mediaType ?? inferMediaTypeFromUrl(part.url) ?? 'image/*',
                },
            };
        case 'text':
            return {
                text: part.text,
            };
        case 'tool_call':
            if (role !== 'assistant') {
                throw new ProviderCapabilityError('Gemini tool calls must appear in assistant messages.', {
                    provider: 'google',
                });
            }
            return {
                functionCall: {
                    args: part.args,
                    name: part.name,
                },
            };
        case 'tool_result':
            if (role !== 'user') {
                throw new ProviderCapabilityError('Gemini tool results must appear in user messages.', {
                    provider: 'google',
                });
            }
            return {
                functionResponse: {
                    name: part.name ?? part.toolCallId,
                    response: normalizeGeminiToolResult(part.result, part.isError),
                },
            };
    }
}
function translateGeminiSystemInstruction(systemMessages, explicitSystem) {
    if (!explicitSystem && systemMessages.length === 0) {
        return undefined;
    }
    const parts = [];
    if (explicitSystem) {
        parts.push({ text: explicitSystem });
    }
    for (const message of systemMessages) {
        if (typeof message.content === 'string') {
            parts.push({ text: message.content });
            continue;
        }
        for (const part of message.content) {
            if (part.type !== 'text') {
                throw new ProviderCapabilityError('Gemini system instructions currently support text content only.', {
                    provider: 'google',
                });
            }
            parts.push({ text: part.text });
        }
    }
    return { parts };
}
function applyGeminiCacheExpiration(body, ttl, expireTime) {
    if (ttl && expireTime) {
        throw new ProviderError('Gemini cache requests accept either ttl or expireTime, not both.', {
            provider: 'google',
        });
    }
    if (ttl) {
        body.ttl = ttl;
    }
    if (expireTime) {
        body.expireTime = expireTime;
    }
}
function normalizeGeminiCacheModelName(model) {
    return model.startsWith('models/') ? model : `models/${model}`;
}
function normalizeGeminiModelId(model) {
    return model.startsWith('models/') ? model.slice('models/'.length) : model;
}
function normalizeGeminiCachedContentName(name) {
    return name.startsWith('cachedContents/') ? name : `cachedContents/${name}`;
}
function translateGeminiSchema(schema) {
    const translated = {
        type: schema.type.toUpperCase(),
    };
    if (schema.description !== undefined) {
        translated.description = schema.description;
    }
    if (schema.enum !== undefined) {
        translated.enum = schema.enum;
    }
    if (schema.required !== undefined) {
        translated.required = schema.required;
    }
    if (schema.additionalProperties !== undefined) {
        translated.additionalProperties = schema.additionalProperties;
    }
    if (schema.items !== undefined) {
        translated.items = translateGeminiSchema(schema.items);
    }
    if (schema.properties !== undefined) {
        translated.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [
            key,
            translateGeminiSchema(value),
        ]));
    }
    return translated;
}
function normalizeGeminiFinishReason(finishReason, parts) {
    switch (finishReason) {
        case 'MAX_TOKENS':
            return 'length';
        case 'BLOCKLIST':
        case 'PROHIBITED_CONTENT':
        case 'RECITATION':
        case 'SAFETY':
        case 'SPII':
            return 'content_filter';
        case 'STOP':
            return parts.some((part) => 'functionCall' in part) ? 'tool_call' : 'stop';
        case 'LANGUAGE':
        case 'MALFORMED_FUNCTION_CALL':
        case 'OTHER':
            return 'error';
        case null:
            return 'stop';
    }
}
function messageContainsVisionContent(message) {
    return (typeof message.content !== 'string' &&
        message.content.some((part) => part.type === 'image_base64' || part.type === 'image_url'));
}
function translateGeminiBinaryLikePart(data, mediaType, url, missingMessage) {
    if (data) {
        return {
            inlineData: {
                data,
                mimeType: mediaType,
            },
        };
    }
    if (url) {
        return {
            fileData: {
                fileUri: url,
                mimeType: mediaType,
            },
        };
    }
    throw new ProviderCapabilityError(missingMessage, {
        provider: 'google',
    });
}
function normalizeGeminiToolResult(result, isError) {
    if (isPlainJsonObject(result)) {
        return isError ? { ...result, isError } : result;
    }
    if (isError) {
        return {
            isError,
            result,
        };
    }
    return {
        result,
    };
}
function isPlainJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function inferMediaTypeFromUrl(url) {
    const normalized = url.toLowerCase();
    if (normalized.endsWith('.png')) {
        return 'image/png';
    }
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
        return 'image/jpeg';
    }
    if (normalized.endsWith('.gif')) {
        return 'image/gif';
    }
    if (normalized.endsWith('.webp')) {
        return 'image/webp';
    }
    return null;
}
function buildGeminiToolCallId(candidateIndex, partIndex, toolName) {
    return `gemini_tool_${candidateIndex}_${partIndex}_${toolName}`;
}
function buildGeminiErrorOptions(statusCode, model, requestId, details, retryable) {
    return {
        ...(details ? { details: { errorDetails: details } } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        provider: 'google',
        retryable,
        statusCode,
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
