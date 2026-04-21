import { AuthenticationError, BudgetExceededError, LLMError, ProviderCapabilityError, ProviderError, RateLimitError, } from './errors.js';
import { ModelRegistry } from './models/registry.js';
import { Conversation } from './conversation.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OpenAIAdapter } from './providers/openai.js';
import { getEnvironmentVariable } from './runtime.js';
import { PostgresSessionStore } from './session-store.js';
import { createCancelableStream } from './stream-control.js';
import { calcCostUSD, estimateMessageTokens, formatCost } from './utils/index.js';
import { exportUsageSummary } from './usage.js';
/**
 * Unified entry point for provider-agnostic completions, streaming,
 * conversations, routing, and usage logging.
 *
 * @example
 * ```ts
 * const client = LLMClient.fromEnv({
 *   defaultModel: 'gpt-4o',
 * });
 *
 * const response = await client.complete({
 *   messages: [{ content: 'Say hello.', role: 'user' }],
 * });
 * ```
 */
export class LLMClient {
    anthropicAdapter;
    budgetExceededAction;
    defaultModel;
    defaultProvider;
    geminiAdapter;
    modelRegistry;
    modelRouter;
    onWarning;
    openaiAdapter;
    sessionStore;
    usageLogger;
    models;
    googleCaches;
    constructor(options = {}) {
        const modelRegistry = options.modelRegistry ??
            new ModelRegistry(undefined, options.modelRegistryOptions);
        this.modelRegistry = modelRegistry;
        this.budgetExceededAction = options.budgetExceededAction ?? 'throw';
        this.defaultModel = options.defaultModel;
        this.defaultProvider = options.defaultProvider;
        this.modelRouter = options.modelRouter;
        this.onWarning = options.onWarning ?? ((message) => console.warn(message));
        this.sessionStore =
            options.sessionStore ?? resolveDefaultSessionStore(options.sessionStore);
        this.usageLogger = options.usageLogger;
        const anthropicApiKey = options.anthropicApiKey ?? getEnvironmentVariable('ANTHROPIC_API_KEY');
        const geminiApiKey = options.geminiApiKey ?? getEnvironmentVariable('GEMINI_API_KEY');
        const openaiApiKey = options.openaiApiKey ?? getEnvironmentVariable('OPENAI_API_KEY');
        const fetchImplementation = options.fetchImplementation;
        this.anthropicAdapter = anthropicApiKey
            ? new AnthropicAdapter(buildAnthropicConfig(anthropicApiKey, fetchImplementation, modelRegistry, options.retryOptions))
            : null;
        this.openaiAdapter = openaiApiKey
            ? new OpenAIAdapter(buildOpenAIConfig(openaiApiKey, fetchImplementation, modelRegistry, options.openaiOrganization ?? getEnvironmentVariable('OPENAI_ORG_ID'), options.openaiProject ?? getEnvironmentVariable('OPENAI_PROJECT_ID'), options.retryOptions))
            : null;
        this.geminiAdapter = geminiApiKey
            ? new GeminiAdapter(buildGeminiConfig(geminiApiKey, fetchImplementation, modelRegistry, options.retryOptions))
            : null;
        this.models = {
            get: this.modelRegistry.get.bind(this.modelRegistry),
            list: this.modelRegistry.list.bind(this.modelRegistry),
            register: this.modelRegistry.register.bind(this.modelRegistry),
        };
        this.googleCaches = {
            create: (cacheOptions) => this.getGeminiAdapter(cacheOptions.model).createCache(cacheOptions),
            delete: (name) => this.getGeminiCacheAdapter().deleteCache(name),
            get: (name) => this.getGeminiCacheAdapter().getCache(name),
            list: (cacheOptions) => this.getGeminiCacheAdapter().listCaches(cacheOptions),
            update: (name, cacheOptions) => this.getGeminiCacheAdapter().updateCache(name, cacheOptions),
        };
    }
    /**
     * Creates a client that reads provider credentials from the current
     * environment.
     */
    static fromEnv(options = {}) {
        return new LLMClient(options);
    }
    /** Creates a deterministic in-memory client for tests. */
    static mock(options = {}) {
        return new MockLLMClient(options);
    }
    /** Executes a single non-streaming completion request. */
    async complete(options) {
        const plan = this.resolveRequestPlan(options);
        const startedAt = Date.now();
        const attemptedRoutes = [];
        for (const [index, attempt] of plan.attempts.entries()) {
            attemptedRoutes.push(attempt.decision);
            try {
                const budgetDecision = this.handleBudgetExceededAction(attempt.request);
                if (budgetDecision.action === 'skip') {
                    const response = buildBudgetSkipResponse(budgetDecision.error, attempt.request);
                    await this.logUsageEvent(buildUsageEvent({
                        durationMs: Date.now() - startedAt,
                        finishReason: response.finishReason,
                        model: response.model,
                        options,
                        provider: response.provider,
                        usage: response.usage,
                        ...(joinRoutingDecision(attemptedRoutes)
                            ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                            : {}),
                    }));
                    return response;
                }
                const response = await this.dispatchComplete(attempt.request);
                await this.logUsageEvent(buildUsageEvent({
                    durationMs: Date.now() - startedAt,
                    finishReason: response.finishReason,
                    model: response.model,
                    options,
                    provider: response.provider,
                    usage: response.usage,
                    ...(joinRoutingDecision(attemptedRoutes)
                        ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                        : {}),
                }));
                return response;
            }
            catch (error) {
                if (!shouldTryFallback(error) || index === plan.attempts.length - 1) {
                    throw error;
                }
            }
        }
        throw new ProviderCapabilityError('No model route attempts were available.');
    }
    /** Executes a streaming completion request and yields canonical chunks. */
    stream(options) {
        const plan = this.resolveRequestPlan(options);
        const startedAt = Date.now();
        return createCancelableStream((signal) => this.streamWithFallback(plan, {
            ...options,
            signal,
        }, startedAt), options.signal);
    }
    /**
     * Creates or restores a conversation, automatically hydrating from the
     * configured session store when a matching `sessionId` exists.
     */
    async conversation(options = {}) {
        const store = this.sessionStore;
        if (store && options.sessionId) {
            const stored = await store.get(options.sessionId, options.tenantId);
            if (stored) {
                return Conversation.restore(this, stored.snapshot, {
                    ...options,
                    ...(options.budgetExceededAction !== undefined
                        ? { budgetExceededAction: options.budgetExceededAction }
                        : { budgetExceededAction: this.budgetExceededAction }),
                    ...(options.onWarning !== undefined
                        ? { onWarning: options.onWarning }
                        : { onWarning: this.onWarning }),
                    ...(store ? { store } : {}),
                });
            }
        }
        return new Conversation(this, {
            ...options,
            ...(options.budgetExceededAction !== undefined
                ? { budgetExceededAction: options.budgetExceededAction }
                : { budgetExceededAction: this.budgetExceededAction }),
            ...(options.onWarning !== undefined
                ? { onWarning: options.onWarning }
                : { onWarning: this.onWarning }),
            ...(store ? { store } : {}),
        });
    }
    /** Applies runtime price overrides to the shared model registry. */
    updatePrices(overrides) {
        this.modelRegistry.updatePrices(overrides);
    }
    /** Returns aggregated usage from the configured usage logger. */
    async getUsage(query = {}) {
        if (!this.usageLogger?.getUsage) {
            throw new ProviderCapabilityError('Usage aggregation requires a usage logger that implements getUsage(), such as PostgresUsageLogger.');
        }
        return this.usageLogger.getUsage(query);
    }
    /** Returns aggregated usage serialized as JSON or CSV. */
    async exportUsage(format, query = {}) {
        return exportUsageSummary(await this.getUsage(query), format);
    }
    /** Returns the session store configured on this client, if any. */
    getSessionStore() {
        return this.sessionStore;
    }
    getAnthropicAdapter(model) {
        if (!this.anthropicAdapter) {
            throw new AuthenticationError('Anthropic API key is missing. Populate ANTHROPIC_API_KEY in .env or pass anthropicApiKey to LLMClient.', {
                model,
                provider: 'anthropic',
            });
        }
        return this.anthropicAdapter;
    }
    getGeminiAdapter(model) {
        if (!this.geminiAdapter) {
            throw new AuthenticationError('Gemini API key is missing. Populate GEMINI_API_KEY in .env or pass geminiApiKey to LLMClient.', {
                model,
                provider: 'google',
            });
        }
        return this.geminiAdapter;
    }
    getGeminiCacheAdapter() {
        if (!this.geminiAdapter) {
            throw new AuthenticationError('Gemini API key is missing. Populate GEMINI_API_KEY in .env or pass geminiApiKey to LLMClient.', {
                provider: 'google',
            });
        }
        return this.geminiAdapter;
    }
    getOpenAIAdapter(model) {
        if (!this.openaiAdapter) {
            throw new AuthenticationError('OpenAI API key is missing. Populate OPENAI_API_KEY in .env or pass openaiApiKey to LLMClient.', {
                model,
                provider: 'openai',
            });
        }
        return this.openaiAdapter;
    }
    dispatchComplete(resolved) {
        switch (resolved.provider) {
            case 'anthropic':
                return this.getAnthropicAdapter(resolved.model).complete(resolved);
            case 'google':
                return this.getGeminiAdapter(resolved.model).complete(resolved);
            case 'openai':
                return this.getOpenAIAdapter(resolved.model).complete(resolved);
            default:
                throw new ProviderCapabilityError(`Provider "${resolved.provider}" is not implemented in this client yet.`, {
                    model: resolved.model,
                    provider: resolved.provider,
                });
        }
    }
    dispatchStream(resolved) {
        switch (resolved.provider) {
            case 'anthropic':
                return this.getAnthropicAdapter(resolved.model).stream(resolved);
            case 'google':
                return this.getGeminiAdapter(resolved.model).stream(resolved);
            case 'openai':
                return this.getOpenAIAdapter(resolved.model).stream(resolved);
            default:
                throw new ProviderCapabilityError(`Provider "${resolved.provider}" is not implemented in this client yet.`, {
                    model: resolved.model,
                    provider: resolved.provider,
                });
        }
    }
    resolveRequest(options, target = {}) {
        const model = target.model ?? options.model ?? this.defaultModel;
        if (!model) {
            throw new ProviderCapabilityError('No model was supplied. Set defaultModel on LLMClient or pass model per request.');
        }
        const modelInfo = this.modelRegistry.get(model);
        const provider = target.provider ?? options.provider ?? this.defaultProvider ?? modelInfo.provider;
        if (provider !== modelInfo.provider) {
            throw new ProviderCapabilityError(`Model "${model}" belongs to provider "${modelInfo.provider}", but request asked for "${provider}".`, {
                model,
                provider,
            });
        }
        return {
            ...options,
            maxTokens: options.maxTokens ?? 1024,
            model,
            provider,
        };
    }
    resolveRequestPlan(options) {
        const resolvedRoute = this.resolveRoute(options);
        return {
            attempts: resolvedRoute.attempts.map((attempt) => ({
                decision: attempt.decision,
                request: this.resolveRequest(options, attempt),
            })),
        };
    }
    resolveRoute(options) {
        if (!this.modelRouter) {
            const directRequest = this.resolveRequest(options);
            const decision = options.model ? `requested:${directRequest.model}` : `default:${directRequest.model}`;
            return {
                attempts: [
                    {
                        decision,
                        model: directRequest.model,
                        provider: directRequest.provider,
                    },
                ],
                decision,
            };
        }
        return this.modelRouter.resolve(this.buildRouterContext(options), {
            modelRegistry: this.modelRegistry,
            ...(this.defaultModel !== undefined ? { defaultModel: this.defaultModel } : {}),
            ...(this.defaultProvider !== undefined
                ? { defaultProvider: this.defaultProvider }
                : {}),
        });
    }
    buildRouterContext(options) {
        return {
            maxTokens: options.maxTokens ?? 1024,
            messages: options.messages,
            ...(options.model !== undefined ? { requestedModel: options.model } : {}),
            ...(options.provider !== undefined ? { requestedProvider: options.provider } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options.system !== undefined ? { system: options.system } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
            ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
            ...(options.tools !== undefined ? { tools: options.tools } : {}),
        };
    }
    resolveBudgetExceededError(options) {
        if (options.budgetUsd === undefined) {
            return null;
        }
        const estimatedMessages = options.system
            ? [{ content: options.system, role: 'system' }, ...options.messages]
            : options.messages;
        const estimatedInputTokens = estimateMessageTokens(estimatedMessages);
        const estimatedOutputTokens = options.maxTokens;
        const estimatedCostUSD = calcCostUSD({
            inputTokens: estimatedInputTokens,
            model: options.model,
            outputTokens: estimatedOutputTokens,
        }, this.modelRegistry);
        if (estimatedCostUSD <= options.budgetUsd) {
            return null;
        }
        return new BudgetExceededError(`Estimated request cost ${formatCost(estimatedCostUSD)} exceeds the budget of ${formatCost(options.budgetUsd)}.`, {
            details: {
                budgetUsd: options.budgetUsd,
                estimatedCostUSD,
                estimatedInputTokens,
                estimatedOutputTokens,
            },
            model: options.model,
            provider: options.provider,
        });
    }
    handleBudgetExceededAction(options) {
        const error = this.resolveBudgetExceededError(options);
        if (!error) {
            return { action: 'continue' };
        }
        const action = options.budgetExceededAction ?? this.budgetExceededAction;
        if (action === 'warn') {
            this.onWarning(error.message);
            return { action: 'continue' };
        }
        if (action === 'skip') {
            return { action: 'skip', error };
        }
        throw error;
    }
    async logUsageEvent(event) {
        if (!this.usageLogger) {
            return;
        }
        try {
            await this.usageLogger.log(event);
        }
        catch {
            return;
        }
    }
    async *streamWithFallback(plan, options, startedAt) {
        const attemptedRoutes = [];
        for (const [index, attempt] of plan.attempts.entries()) {
            attemptedRoutes.push(attempt.decision);
            let emittedUserVisibleChunk = false;
            try {
                const budgetDecision = this.handleBudgetExceededAction(attempt.request);
                if (budgetDecision.action === 'skip') {
                    const skipped = buildBudgetSkipResponse(budgetDecision.error, attempt.request);
                    yield { delta: skipped.text, type: 'text-delta' };
                    await this.logUsageEvent(buildUsageEvent({
                        durationMs: Date.now() - startedAt,
                        finishReason: skipped.finishReason,
                        model: skipped.model,
                        options,
                        provider: skipped.provider,
                        usage: skipped.usage,
                        ...(joinRoutingDecision(attemptedRoutes)
                            ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                            : {}),
                    }));
                    yield {
                        finishReason: skipped.finishReason,
                        type: 'done',
                        usage: skipped.usage,
                    };
                    return;
                }
                for await (const chunk of this.dispatchStream(attempt.request)) {
                    emittedUserVisibleChunk = true;
                    if (chunk.type === 'done') {
                        await this.logUsageEvent(buildUsageEvent({
                            durationMs: Date.now() - startedAt,
                            finishReason: chunk.finishReason,
                            model: attempt.request.model,
                            options,
                            provider: attempt.request.provider,
                            usage: chunk.usage,
                            ...(joinRoutingDecision(attemptedRoutes)
                                ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                                : {}),
                        }));
                    }
                    yield chunk;
                }
                return;
            }
            catch (error) {
                if (emittedUserVisibleChunk ||
                    !shouldTryFallback(error) ||
                    index === plan.attempts.length - 1) {
                    throw error;
                }
            }
        }
    }
}
class MockLLMClient extends LLMClient {
    mockDefaultModel;
    mockDefaultProvider;
    responseQueue;
    streamQueue;
    constructor(options = {}) {
        const defaultModel = options.defaultModel ?? 'mock-model';
        const defaultProvider = options.defaultProvider ?? 'mock';
        super({
            ...options,
            defaultModel,
            defaultProvider,
        });
        this.mockDefaultModel = defaultModel;
        this.mockDefaultProvider = defaultProvider;
        this.responseQueue = [...(options.responses ?? [])];
        this.streamQueue = [...(options.streams ?? [])];
    }
    async complete(options) {
        const resolved = this.resolveMockRequest(options);
        const next = this.responseQueue.shift();
        if (!next) {
            return buildMockResponse(extractLastUserText(resolved.messages), resolved);
        }
        const response = typeof next === 'function' ? await next(resolved) : next;
        return response;
    }
    stream(options) {
        return createCancelableStream(async function* () {
            const resolved = this.resolveMockRequest(options);
            const next = this.streamQueue.shift();
            if (!next) {
                const response = buildMockResponse(extractLastUserText(resolved.messages), resolved);
                if (response.text.length > 0) {
                    yield { delta: response.text, type: 'text-delta' };
                }
                yield {
                    finishReason: response.finishReason,
                    type: 'done',
                    usage: response.usage,
                };
                return;
            }
            const stream = typeof next === 'function' ? await next(resolved) : next;
            if (isAsyncIterable(stream)) {
                for await (const chunk of stream) {
                    yield chunk;
                }
                return;
            }
            for (const chunk of stream) {
                yield chunk;
            }
        }.bind(this), options.signal);
    }
    resolveMockRequest(options) {
        return {
            ...options,
            maxTokens: options.maxTokens ?? 1024,
            model: options.model ?? this.mockDefaultModel,
            provider: options.provider ?? this.mockDefaultProvider,
        };
    }
}
function buildAnthropicConfig(apiKey, fetchImplementation, modelRegistry, retryOptions) {
    return {
        apiKey,
        modelRegistry,
        ...(fetchImplementation ? { fetchImplementation } : {}),
        ...(retryOptions ? { retryOptions } : {}),
    };
}
function buildOpenAIConfig(apiKey, fetchImplementation, modelRegistry, organization, project, retryOptions) {
    return {
        apiKey,
        modelRegistry,
        ...(fetchImplementation ? { fetchImplementation } : {}),
        ...(organization ? { organization } : {}),
        ...(project ? { project } : {}),
        ...(retryOptions ? { retryOptions } : {}),
    };
}
function buildGeminiConfig(apiKey, fetchImplementation, modelRegistry, retryOptions) {
    return {
        apiKey,
        modelRegistry,
        ...(fetchImplementation ? { fetchImplementation } : {}),
        ...(retryOptions ? { retryOptions } : {}),
    };
}
function resolveDefaultSessionStore(sessionStore) {
    if (sessionStore) {
        return sessionStore;
    }
    if (!getEnvironmentVariable('DATABASE_URL')) {
        return undefined;
    }
    return PostgresSessionStore.fromEnv();
}
function buildBudgetSkipResponse(error, request) {
    return {
        content: [{ text: error.message, type: 'text' }],
        finishReason: 'error',
        model: request.model,
        provider: request.provider,
        raw: {
            reason: 'budget_exceeded',
            skipped: true,
            ...(error.details ? { details: error.details } : {}),
        },
        text: error.message,
        toolCalls: [],
        usage: buildZeroUsage(),
    };
}
function buildMockResponse(text, request) {
    return {
        content: text.length > 0 ? [{ text, type: 'text' }] : [],
        finishReason: 'stop',
        model: request.model,
        provider: request.provider,
        raw: {},
        text,
        toolCalls: [],
        usage: buildZeroUsage(),
    };
}
function extractLastUserText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') {
            continue;
        }
        if (typeof message.content === 'string') {
            return message.content;
        }
        return message.content
            .map((part) => {
            if (part.type === 'text') {
                return part.text;
            }
            return '';
        })
            .join(' ')
            .trim();
    }
    return '';
}
function isAsyncIterable(value) {
    return typeof value[Symbol.asyncIterator] === 'function';
}
function buildUsageEvent(input) {
    return {
        ...input.usage,
        durationMs: input.durationMs,
        finishReason: input.finishReason,
        model: input.model,
        provider: input.provider,
        timestamp: new Date().toISOString(),
        ...(input.options.botId !== undefined ? { botId: input.options.botId } : {}),
        ...(input.routingDecision ? { routingDecision: input.routingDecision } : {}),
        ...(input.options.sessionId !== undefined ? { sessionId: input.options.sessionId } : {}),
        ...(input.options.tenantId !== undefined ? { tenantId: input.options.tenantId } : {}),
    };
}
function joinRoutingDecision(attemptedRoutes) {
    if (attemptedRoutes.length === 0) {
        return undefined;
    }
    return attemptedRoutes.join(' -> ');
}
function shouldTryFallback(error) {
    return (error instanceof AuthenticationError ||
        error instanceof ProviderError ||
        error instanceof RateLimitError ||
        (error instanceof LLMError && error.retryable));
}
function buildZeroUsage() {
    return {
        cachedTokens: 0,
        cost: '$0.00',
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
    };
}
