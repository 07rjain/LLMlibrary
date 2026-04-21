import {
  AuthenticationError,
  BudgetExceededError,
  LLMError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from './errors.js';
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

import type { ModelRegistryOptions, ModelPriceOverrides } from './models/index.js';
import type { ConversationOptions, ConversationSnapshot } from './conversation.js';
import type {
  GeminiCachedContent,
  GeminiCachedContentPage,
  GeminiCreateCacheOptions,
  GeminiListCachesOptions,
  GeminiUpdateCacheOptions,
} from './providers/gemini.js';
import type { SessionStore } from './session-store.js';
import type { ModelRouter, ResolvedModelRoute, RouterContext } from './router.js';
import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalProvider,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolChoice,
  BudgetExceededAction,
  CancelableStream,
  ProviderOptions,
  StreamChunk,
  UsageEvent,
  UsageMetrics,
} from './types.js';
import type {
  UsageExportFormat,
  UsageLogger,
  UsageQuery,
  UsageSummary,
} from './usage.js';
import type { RetryOptions } from './utils/retry.js';

/** Constructor options for `LLMClient`. */
export interface LLMClientOptions {
  anthropicApiKey?: string;
  budgetExceededAction?: BudgetExceededAction;
  defaultModel?: string;
  defaultProvider?: CanonicalProvider;
  fetchImplementation?: typeof fetch;
  geminiApiKey?: string;
  modelRegistry?: ModelRegistry;
  modelRegistryOptions?: ModelRegistryOptions;
  modelRouter?: ModelRouter;
  onWarning?: (message: string) => void;
  openaiApiKey?: string;
  openaiOrganization?: string;
  openaiProject?: string;
  retryOptions?: RetryOptions;
  sessionStore?: SessionStore<ConversationSnapshot>;
  usageLogger?: UsageLogger;
}

/** Canonical request options shared by `complete()` and `stream()`. */
export interface LLMRequestOptions {
  botId?: string;
  budgetExceededAction?: BudgetExceededAction;
  budgetUsd?: number;
  maxTokens?: number;
  messages: CanonicalMessage[];
  model?: string;
  provider?: CanonicalProvider;
  providerOptions?: ProviderOptions;
  sessionId?: string;
  signal?: AbortSignal;
  system?: string;
  temperature?: number;
  tenantId?: string;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

/** Configuration for `LLMClient.mock()` test instances. */
export interface MockLLMClientOptions
  extends Omit<
    LLMClientOptions,
    'anthropicApiKey' | 'geminiApiKey' | 'openaiApiKey'
  > {
  responses?: Array<
    | CanonicalResponse
    | ((
        options: LLMRequestOptions & {
          maxTokens: number;
          model: string;
          provider: CanonicalProvider;
        },
      ) => CanonicalResponse | Promise<CanonicalResponse>)
  >;
  streams?: Array<
    | AsyncIterable<StreamChunk>
    | StreamChunk[]
    | ((
        options: LLMRequestOptions & {
          maxTokens: number;
          model: string;
          provider: CanonicalProvider;
        },
      ) =>
        | AsyncIterable<StreamChunk>
        | Promise<AsyncIterable<StreamChunk> | StreamChunk[]>
        | StreamChunk[])
  >;
}

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
  private readonly anthropicAdapter: AnthropicAdapter | null;
  private readonly budgetExceededAction: BudgetExceededAction;
  private readonly defaultModel: string | undefined;
  private readonly defaultProvider: CanonicalProvider | undefined;
  private readonly geminiAdapter: GeminiAdapter | null;
  private readonly modelRegistry: ModelRegistry;
  private readonly modelRouter: ModelRouter | undefined;
  private readonly onWarning: (message: string) => void;
  private readonly openaiAdapter: OpenAIAdapter | null;
  private readonly sessionStore: SessionStore<ConversationSnapshot> | undefined;
  private readonly usageLogger: UsageLogger | undefined;

  readonly models: {
    get: ModelRegistry['get'];
    list: ModelRegistry['list'];
    register: ModelRegistry['register'];
  };
  readonly googleCaches: {
    create: (options: GeminiCreateCacheOptions) => Promise<GeminiCachedContent>;
    delete: (name: string) => Promise<void>;
    get: (name: string) => Promise<GeminiCachedContent>;
    list: (options?: GeminiListCachesOptions) => Promise<GeminiCachedContentPage>;
    update: (
      name: string,
      options: GeminiUpdateCacheOptions,
    ) => Promise<GeminiCachedContent>;
  };

  constructor(options: LLMClientOptions = {}) {
    const modelRegistry =
      options.modelRegistry ??
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
      ? new AnthropicAdapter(
          buildAnthropicConfig(
            anthropicApiKey,
            fetchImplementation,
            modelRegistry,
            options.retryOptions,
          ),
        )
      : null;

    this.openaiAdapter = openaiApiKey
      ? new OpenAIAdapter(
          buildOpenAIConfig(
            openaiApiKey,
            fetchImplementation,
            modelRegistry,
            options.openaiOrganization ?? getEnvironmentVariable('OPENAI_ORG_ID'),
            options.openaiProject ?? getEnvironmentVariable('OPENAI_PROJECT_ID'),
            options.retryOptions,
          ),
        )
      : null;

    this.geminiAdapter = geminiApiKey
      ? new GeminiAdapter(
          buildGeminiConfig(
            geminiApiKey,
            fetchImplementation,
            modelRegistry,
            options.retryOptions,
          ),
        )
      : null;

    this.models = {
      get: this.modelRegistry.get.bind(this.modelRegistry),
      list: this.modelRegistry.list.bind(this.modelRegistry),
      register: this.modelRegistry.register.bind(this.modelRegistry),
    };
    this.googleCaches = {
      create: (cacheOptions) =>
        this.getGeminiAdapter(cacheOptions.model).createCache(cacheOptions),
      delete: (name) => this.getGeminiCacheAdapter().deleteCache(name),
      get: (name) => this.getGeminiCacheAdapter().getCache(name),
      list: (cacheOptions) => this.getGeminiCacheAdapter().listCaches(cacheOptions),
      update: (name, cacheOptions) =>
        this.getGeminiCacheAdapter().updateCache(name, cacheOptions),
    };
  }

  /**
   * Creates a client that reads provider credentials from the current
   * environment.
   */
  static fromEnv(
    options: Omit<
      LLMClientOptions,
      'anthropicApiKey' | 'geminiApiKey' | 'openaiApiKey'
    > = {},
  ): LLMClient {
    return new LLMClient(options);
  }

  /** Creates a deterministic in-memory client for tests. */
  static mock(options: MockLLMClientOptions = {}): LLMClient {
    return new MockLLMClient(options);
  }

  /** Executes a single non-streaming completion request. */
  async complete(options: LLMRequestOptions): Promise<CanonicalResponse> {
    const plan = this.resolveRequestPlan(options);
    const startedAt = Date.now();
    const attemptedRoutes: string[] = [];

    for (const [index, attempt] of plan.attempts.entries()) {
      attemptedRoutes.push(attempt.decision);

      try {
        const budgetDecision = this.handleBudgetExceededAction(attempt.request);
        if (budgetDecision.action === 'skip') {
          const response = buildBudgetSkipResponse(
            budgetDecision.error,
            attempt.request,
          );
          await this.logUsageEvent(
            buildUsageEvent({
              durationMs: Date.now() - startedAt,
              finishReason: response.finishReason,
              model: response.model,
              options,
              provider: response.provider,
              usage: response.usage,
              ...(joinRoutingDecision(attemptedRoutes)
                ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                : {}),
            }),
          );
          return response;
        }
        const response = await this.dispatchComplete(attempt.request);
        await this.logUsageEvent(
          buildUsageEvent({
            durationMs: Date.now() - startedAt,
            finishReason: response.finishReason,
            model: response.model,
            options,
            provider: response.provider,
            usage: response.usage,
            ...(joinRoutingDecision(attemptedRoutes)
              ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
              : {}),
          }),
        );
        return response;
      } catch (error) {
        if (!shouldTryFallback(error) || index === plan.attempts.length - 1) {
          throw error;
        }
      }
    }

    throw new ProviderCapabilityError('No model route attempts were available.');
  }

  /** Executes a streaming completion request and yields canonical chunks. */
  stream(options: LLMRequestOptions): CancelableStream<StreamChunk> {
    const plan = this.resolveRequestPlan(options);
    const startedAt = Date.now();

    return createCancelableStream(
      (signal) =>
        this.streamWithFallback(
          plan,
          {
            ...options,
            signal,
          },
          startedAt,
        ),
      options.signal,
    );
  }

  /**
   * Creates or restores a conversation, automatically hydrating from the
   * configured session store when a matching `sessionId` exists.
   */
  async conversation(
    options: Omit<ConversationOptions, 'store'> = {},
  ): Promise<Conversation> {
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
  updatePrices(overrides: ModelPriceOverrides): void {
    this.modelRegistry.updatePrices(overrides);
  }

  /** Returns aggregated usage from the configured usage logger. */
  async getUsage(query: UsageQuery = {}): Promise<UsageSummary> {
    if (!this.usageLogger?.getUsage) {
      throw new ProviderCapabilityError(
        'Usage aggregation requires a usage logger that implements getUsage(), such as PostgresUsageLogger.',
      );
    }

    return this.usageLogger.getUsage(query);
  }

  /** Returns aggregated usage serialized as JSON or CSV. */
  async exportUsage(
    format: UsageExportFormat,
    query: UsageQuery = {},
  ): Promise<string> {
    return exportUsageSummary(await this.getUsage(query), format);
  }

  /** Returns the session store configured on this client, if any. */
  getSessionStore(): SessionStore<ConversationSnapshot> | undefined {
    return this.sessionStore;
  }

  private getAnthropicAdapter(model: string): AnthropicAdapter {
    if (!this.anthropicAdapter) {
      throw new AuthenticationError(
        'Anthropic API key is missing. Populate ANTHROPIC_API_KEY in .env or pass anthropicApiKey to LLMClient.',
        {
          model,
          provider: 'anthropic',
        },
      );
    }

    return this.anthropicAdapter;
  }

  private getGeminiAdapter(model: string): GeminiAdapter {
    if (!this.geminiAdapter) {
      throw new AuthenticationError(
        'Gemini API key is missing. Populate GEMINI_API_KEY in .env or pass geminiApiKey to LLMClient.',
        {
          model,
          provider: 'google',
        },
      );
    }

    return this.geminiAdapter;
  }

  private getGeminiCacheAdapter(): GeminiAdapter {
    if (!this.geminiAdapter) {
      throw new AuthenticationError(
        'Gemini API key is missing. Populate GEMINI_API_KEY in .env or pass geminiApiKey to LLMClient.',
        {
          provider: 'google',
        },
      );
    }

    return this.geminiAdapter;
  }

  private getOpenAIAdapter(model: string): OpenAIAdapter {
    if (!this.openaiAdapter) {
      throw new AuthenticationError(
        'OpenAI API key is missing. Populate OPENAI_API_KEY in .env or pass openaiApiKey to LLMClient.',
        {
          model,
          provider: 'openai',
        },
      );
    }

    return this.openaiAdapter;
  }

  private dispatchComplete(
    resolved: LLMRequestOptions & {
      maxTokens: number;
      model: string;
      provider: CanonicalProvider;
    },
  ): Promise<CanonicalResponse> {
    switch (resolved.provider) {
      case 'anthropic':
        return this.getAnthropicAdapter(resolved.model).complete(resolved);
      case 'google':
        return this.getGeminiAdapter(resolved.model).complete(resolved);
      case 'openai':
        return this.getOpenAIAdapter(resolved.model).complete(resolved);
      default:
        throw new ProviderCapabilityError(
          `Provider "${resolved.provider}" is not implemented in this client yet.`,
          {
            model: resolved.model,
            provider: resolved.provider,
          },
        );
    }
  }

  private dispatchStream(
    resolved: LLMRequestOptions & {
      maxTokens: number;
      model: string;
      provider: CanonicalProvider;
    },
  ): AsyncIterable<StreamChunk> {
    switch (resolved.provider) {
      case 'anthropic':
        return this.getAnthropicAdapter(resolved.model).stream(resolved);
      case 'google':
        return this.getGeminiAdapter(resolved.model).stream(resolved);
      case 'openai':
        return this.getOpenAIAdapter(resolved.model).stream(resolved);
      default:
        throw new ProviderCapabilityError(
          `Provider "${resolved.provider}" is not implemented in this client yet.`,
          {
            model: resolved.model,
            provider: resolved.provider,
          },
        );
    }
  }

  private resolveRequest(
    options: LLMRequestOptions,
    target: {
      model?: string;
      provider?: CanonicalProvider;
    } = {},
  ): LLMRequestOptions & {
    maxTokens: number;
    model: string;
    provider: CanonicalProvider;
  } {
    const model = target.model ?? options.model ?? this.defaultModel;
    if (!model) {
      throw new ProviderCapabilityError(
        'No model was supplied. Set defaultModel on LLMClient or pass model per request.',
      );
    }

    const modelInfo = this.modelRegistry.get(model);
    const provider =
      target.provider ?? options.provider ?? this.defaultProvider ?? modelInfo.provider;

    if (provider !== modelInfo.provider) {
      throw new ProviderCapabilityError(
        `Model "${model}" belongs to provider "${modelInfo.provider}", but request asked for "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    return {
      ...options,
      maxTokens: options.maxTokens ?? 1024,
      model,
      provider,
    };
  }

  private resolveRequestPlan(options: LLMRequestOptions): {
    attempts: Array<{
      decision: string;
      request: LLMRequestOptions & {
        maxTokens: number;
        model: string;
        provider: CanonicalProvider;
      };
    }>;
  } {
    const resolvedRoute = this.resolveRoute(options);
    return {
      attempts: resolvedRoute.attempts.map((attempt) => ({
        decision: attempt.decision,
        request: this.resolveRequest(options, attempt),
      })),
    };
  }

  private resolveRoute(options: LLMRequestOptions): ResolvedModelRoute {
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

  private buildRouterContext(options: LLMRequestOptions): RouterContext {
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

  private resolveBudgetExceededError(
    options: LLMRequestOptions & {
      maxTokens: number;
      model: string;
      provider: CanonicalProvider;
    },
  ): BudgetExceededError | null {
    if (options.budgetUsd === undefined) {
      return null;
    }

    const estimatedMessages = options.system
      ? [{ content: options.system, role: 'system' as const }, ...options.messages]
      : options.messages;
    const estimatedInputTokens = estimateMessageTokens(estimatedMessages);
    const estimatedOutputTokens = options.maxTokens;
    const estimatedCostUSD = calcCostUSD(
      {
        inputTokens: estimatedInputTokens,
        model: options.model,
        outputTokens: estimatedOutputTokens,
      },
      this.modelRegistry,
    );

    if (estimatedCostUSD <= options.budgetUsd) {
      return null;
    }

    return new BudgetExceededError(
      `Estimated request cost ${formatCost(estimatedCostUSD)} exceeds the budget of ${formatCost(
        options.budgetUsd,
      )}.`,
      {
        details: {
          budgetUsd: options.budgetUsd,
          estimatedCostUSD,
          estimatedInputTokens,
          estimatedOutputTokens,
        },
        model: options.model,
        provider: options.provider,
      },
    );
  }

  private handleBudgetExceededAction(
    options: LLMRequestOptions & {
      maxTokens: number;
      model: string;
      provider: CanonicalProvider;
    },
  ): { action: 'continue' } | { action: 'skip'; error: BudgetExceededError } {
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

  private async logUsageEvent(event: UsageEvent): Promise<void> {
    if (!this.usageLogger) {
      return;
    }

    try {
      await this.usageLogger.log(event);
    } catch {
      return;
    }
  }

  private async *streamWithFallback(
    plan: {
      attempts: Array<{
        decision: string;
        request: LLMRequestOptions & {
          maxTokens: number;
          model: string;
          provider: CanonicalProvider;
        };
      }>;
    },
    options: LLMRequestOptions,
    startedAt: number,
  ): AsyncGenerator<StreamChunk, void, void> {
    const attemptedRoutes: string[] = [];

    for (const [index, attempt] of plan.attempts.entries()) {
      attemptedRoutes.push(attempt.decision);
      let emittedUserVisibleChunk = false;

      try {
        const budgetDecision = this.handleBudgetExceededAction(attempt.request);
        if (budgetDecision.action === 'skip') {
          const skipped = buildBudgetSkipResponse(
            budgetDecision.error,
            attempt.request,
          );
          yield { delta: skipped.text, type: 'text-delta' };
          await this.logUsageEvent(
            buildUsageEvent({
              durationMs: Date.now() - startedAt,
              finishReason: skipped.finishReason,
              model: skipped.model,
              options,
              provider: skipped.provider,
              usage: skipped.usage,
              ...(joinRoutingDecision(attemptedRoutes)
                ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                : {}),
            }),
          );
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
            await this.logUsageEvent(
              buildUsageEvent({
                durationMs: Date.now() - startedAt,
                finishReason: chunk.finishReason,
                model: attempt.request.model,
                options,
                provider: attempt.request.provider,
                usage: chunk.usage,
                ...(joinRoutingDecision(attemptedRoutes)
                  ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                  : {}),
              }),
            );
          }

          yield chunk;
        }

        return;
      } catch (error) {
        if (
          emittedUserVisibleChunk ||
          !shouldTryFallback(error) ||
          index === plan.attempts.length - 1
        ) {
          throw error;
        }
      }
    }
  }
}

class MockLLMClient extends LLMClient {
  private readonly mockDefaultModel: string;
  private readonly mockDefaultProvider: CanonicalProvider;
  private readonly responseQueue: NonNullable<MockLLMClientOptions['responses']>;
  private readonly streamQueue: NonNullable<MockLLMClientOptions['streams']>;

  constructor(options: MockLLMClientOptions = {}) {
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

  override async complete(options: LLMRequestOptions): Promise<CanonicalResponse> {
    const resolved = this.resolveMockRequest(options);
    const next = this.responseQueue.shift();

    if (!next) {
      return buildMockResponse(extractLastUserText(resolved.messages), resolved);
    }

    const response = typeof next === 'function' ? await next(resolved) : next;
    return response;
  }

  override stream(options: LLMRequestOptions): CancelableStream<StreamChunk> {
    return createCancelableStream(
      async function* (
        this: MockLLMClient,
      ): AsyncGenerator<StreamChunk, void, void> {
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
      }.bind(this),
      options.signal,
    );
  }

  private resolveMockRequest(
    options: LLMRequestOptions,
  ): LLMRequestOptions & {
    maxTokens: number;
    model: string;
    provider: CanonicalProvider;
  } {
    return {
      ...options,
      maxTokens: options.maxTokens ?? 1024,
      model: options.model ?? this.mockDefaultModel,
      provider: options.provider ?? this.mockDefaultProvider,
    };
  }
}

function buildAnthropicConfig(
  apiKey: string,
  fetchImplementation: typeof fetch | undefined,
  modelRegistry: ModelRegistry,
  retryOptions: RetryOptions | undefined,
): ConstructorParameters<typeof AnthropicAdapter>[0] {
  return {
    apiKey,
    modelRegistry,
    ...(fetchImplementation ? { fetchImplementation } : {}),
    ...(retryOptions ? { retryOptions } : {}),
  };
}

function buildOpenAIConfig(
  apiKey: string,
  fetchImplementation: typeof fetch | undefined,
  modelRegistry: ModelRegistry,
  organization: string | undefined,
  project: string | undefined,
  retryOptions: RetryOptions | undefined,
): ConstructorParameters<typeof OpenAIAdapter>[0] {
  return {
    apiKey,
    modelRegistry,
    ...(fetchImplementation ? { fetchImplementation } : {}),
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
    ...(retryOptions ? { retryOptions } : {}),
  };
}

function buildGeminiConfig(
  apiKey: string,
  fetchImplementation: typeof fetch | undefined,
  modelRegistry: ModelRegistry,
  retryOptions: RetryOptions | undefined,
): ConstructorParameters<typeof GeminiAdapter>[0] {
  return {
    apiKey,
    modelRegistry,
    ...(fetchImplementation ? { fetchImplementation } : {}),
    ...(retryOptions ? { retryOptions } : {}),
  };
}

function resolveDefaultSessionStore(
  sessionStore: SessionStore<ConversationSnapshot> | undefined,
): SessionStore<ConversationSnapshot> | undefined {
  if (sessionStore) {
    return sessionStore;
  }

  if (!getEnvironmentVariable('DATABASE_URL')) {
    return undefined;
  }

  return PostgresSessionStore.fromEnv<ConversationSnapshot>();
}

function buildBudgetSkipResponse(
  error: BudgetExceededError,
  request: {
    model: string;
    provider: CanonicalProvider;
  },
): CanonicalResponse {
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

function buildMockResponse(
  text: string,
  request: {
    model: string;
    provider: CanonicalProvider;
  },
): CanonicalResponse {
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

function extractLastUserText(messages: CanonicalMessage[]): string {
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

function isAsyncIterable(value: AsyncIterable<StreamChunk> | StreamChunk[]): value is AsyncIterable<StreamChunk> {
  return typeof (value as AsyncIterable<StreamChunk>)[Symbol.asyncIterator] === 'function';
}

function buildUsageEvent(input: {
  durationMs: number;
  finishReason: CanonicalFinishReason;
  model: string;
  options: LLMRequestOptions;
  provider: CanonicalProvider;
  routingDecision?: string | undefined;
  usage: UsageMetrics;
}): UsageEvent {
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

function joinRoutingDecision(attemptedRoutes: string[]): string | undefined {
  if (attemptedRoutes.length === 0) {
    return undefined;
  }

  return attemptedRoutes.join(' -> ');
}

function shouldTryFallback(error: unknown): boolean {
  return (
    error instanceof AuthenticationError ||
    error instanceof ProviderError ||
    error instanceof RateLimitError ||
    (error instanceof LLMError && error.retryable)
  );
}

function buildZeroUsage(): UsageMetrics {
  return {
    cachedTokens: 0,
    cost: '$0.00',
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}
