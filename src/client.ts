import {
  AuthenticationError,
  BudgetExceededError,
  LLMError,
  MockQueueExhaustedError,
  ProviderCapabilityError,
  RateLimitError,
} from 'unified-llm-client/errors';
import { ModelRegistry } from 'unified-llm-client/models';
import { validateBudgetUsd } from './budget-validation.js';
import { validateCompletionCacheOptions } from './cache-validation.js';
import { validateEmbeddingRequest } from './embedding-validation.js';
import { validateAndCloneMetadata } from './json-metadata.js';
import {
  validateSpeechRequest,
  validateTranscriptionRequest,
} from './speech-validation.js';
import { validateAndCloneTools } from './tool-validation.js';
import { Conversation, type ConversationRoute } from './conversation.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OpenAIAdapter } from './providers/openai.js';
import { getEnvironmentVariable } from './runtime.js';
import { PostgresSessionStore } from './session-store.js';
import { createCancelableStream, throwIfAborted } from './stream-control.js';
import { STREAM_EVENT_VERSION } from './types.js';
import {
  assertResponseFormatSupported,
  parseStructuredOutput,
} from './structured-output.js';
import {
  calcCostUSD,
  estimateMessageTokens,
  formatCost,
} from './utils/index.js';
import { calcSpeechCostUSD } from './utils/cost.js';
import { estimateTokens } from './utils/token-estimator.js';
import { exportSpeechUsageSummary, exportUsageSummary } from './usage.js';

import type {
  ModelRegistryOptions,
  ModelPriceOverrides,
} from 'unified-llm-client/models';
import type {
  ConversationOptions,
  ConversationSnapshot,
} from './conversation.js';
import type {
  GeminiCachedContent,
  GeminiCachedContentPage,
  GeminiCreateCacheOptions,
  GeminiListCachesOptions,
  GeminiUpdateCacheOptions,
} from './providers/gemini.js';
import type { SessionStore } from './session-store.js';
import type {
  ModelRouter,
  ResolvedModelRoute,
  RouterContext,
} from './router.js';
import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalProvider,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolChoice,
  BudgetExceededAction,
  CancelableStream,
  EmbeddingProvider,
  EmbeddingRequestOptions,
  EmbeddingResponse,
  JsonValue,
  ProviderOptions,
  RemoteModelInfo,
  RemoteModelListOptions,
  ResponseFormat,
  SpeechProvider,
  SpeechRequestOptions,
  SpeechResponse,
  StreamChunk,
  TranscriptionRequestOptions,
  TranscriptionResponse,
  UsageEvent,
  UsageMetrics,
} from './types.js';
import type {
  UsageExportFormat,
  UsageLogger,
  UsageQuery,
  UsageSummary,
  SpeechUsageQuery,
  SpeechUsageSummary,
} from './usage.js';
import type { RetryOptions } from './utils/retry.js';

/** Constructor options for `LLMClient`. */
export interface LLMClientOptions {
  anthropicApiKey?: string;
  budgetExceededAction?: BudgetExceededAction;
  defaultEmbeddingModel?: string;
  defaultEmbeddingProvider?: EmbeddingProvider;
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
  metadata?: Record<string, JsonValue>;
  maxTokens?: number;
  messages: CanonicalMessage[];
  model?: string;
  provider?: CanonicalProvider;
  providerOptions?: ProviderOptions;
  responseFormat?: ResponseFormat;
  requestId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  system?: string;
  temperature?: number;
  tenantId?: string;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

interface InternalLLMRequestOptions extends LLMRequestOptions {
  resolvedRoute?: {
    attempts?: Array<{
      decision: string;
      model: string;
      provider: CanonicalProvider;
    }>;
    model: string;
    provider: CanonicalProvider;
  };
}

/** Provider-neutral estimate returned before a completion request is sent. */
export interface RequestCostEstimate {
  estimatedCostUSD: number;
  inputTokens: number;
  maxOutputTokens: number;
  model: string;
  priceVersion: string;
  provider: CanonicalProvider;
  reasoningTokens: number;
}

/** Configuration for `LLMClient.mock()` test instances. */
export interface MockLLMClientOptions extends Omit<
  LLMClientOptions,
  'anthropicApiKey' | 'geminiApiKey' | 'openaiApiKey'
> {
  embeddings?: Array<
    | EmbeddingResponse
    | ((
        options: EmbeddingRequestOptions & {
          model: string;
          provider: EmbeddingProvider;
        },
      ) => EmbeddingResponse | Promise<EmbeddingResponse>)
  >;
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
  speeches?: Array<
    | SpeechResponse
    | ((
        options: SpeechRequestOptions & {
          model: string;
          provider: SpeechProvider;
        },
      ) => Promise<SpeechResponse> | SpeechResponse)
  >;
  transcriptions?: Array<
    | TranscriptionResponse
    | ((
        options: TranscriptionRequestOptions & {
          model: string;
          provider: SpeechProvider;
        },
      ) => Promise<TranscriptionResponse> | TranscriptionResponse)
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
  private readonly defaultEmbeddingModel: string | undefined;
  private readonly defaultEmbeddingProvider: EmbeddingProvider | undefined;
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
    listRemote: (options: RemoteModelListOptions) => Promise<RemoteModelInfo[]>;
    register: ModelRegistry['register'];
  };
  readonly googleCaches: {
    create: (options: GeminiCreateCacheOptions) => Promise<GeminiCachedContent>;
    delete: (name: string) => Promise<void>;
    get: (name: string) => Promise<GeminiCachedContent>;
    list: (
      options?: GeminiListCachesOptions,
    ) => Promise<GeminiCachedContentPage>;
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
    this.defaultEmbeddingModel = options.defaultEmbeddingModel;
    this.defaultEmbeddingProvider = options.defaultEmbeddingProvider;
    this.defaultModel = options.defaultModel;
    this.defaultProvider = options.defaultProvider;
    this.modelRouter = options.modelRouter;
    this.onWarning = options.onWarning ?? ((message) => console.warn(message));
    this.sessionStore =
      options.sessionStore ?? resolveDefaultSessionStore(options.sessionStore);
    this.usageLogger = options.usageLogger;

    const anthropicApiKey =
      options.anthropicApiKey ?? getEnvironmentVariable('ANTHROPIC_API_KEY');
    const geminiApiKey =
      options.geminiApiKey ?? getEnvironmentVariable('GEMINI_API_KEY');
    const openaiApiKey =
      options.openaiApiKey ?? getEnvironmentVariable('OPENAI_API_KEY');
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
            options.openaiOrganization ??
              getEnvironmentVariable('OPENAI_ORG_ID'),
            options.openaiProject ??
              getEnvironmentVariable('OPENAI_PROJECT_ID'),
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
      listRemote: this.listRemoteModels.bind(this),
      register: this.modelRegistry.register.bind(this.modelRegistry),
    };
    this.googleCaches = {
      create: (cacheOptions) =>
        this.getGeminiAdapter(cacheOptions.model).createCache(cacheOptions),
      delete: (name) => this.getGeminiAdapter().deleteCache(name),
      get: (name) => this.getGeminiAdapter().getCache(name),
      list: (cacheOptions) => this.getGeminiAdapter().listCaches(cacheOptions),
      update: (name, cacheOptions) =>
        this.getGeminiAdapter().updateCache(name, cacheOptions),
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
    const requestOptions = withValidatedRequest(options);
    throwIfAborted(requestOptions.signal);
    const plan = this.resolveRequestPlan(requestOptions);
    const startedAt = Date.now();
    const attemptedRoutes: string[] = [];

    for (const [index, attempt] of plan.attempts.entries()) {
      throwIfAborted(requestOptions.signal);
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
              options: requestOptions,
              provider: response.provider,
              usage: response.usage,
              ...(joinRoutingDecision(attemptedRoutes)
                ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
                : {}),
            }),
          );
          return response;
        }
        const response = parseStructuredOutput(
          await this.dispatchComplete(attempt.request),
          attempt.request.responseFormat,
        );
        throwIfAborted(requestOptions.signal);
        await this.logUsageEvent(
          buildUsageEvent({
            durationMs: Date.now() - startedAt,
            finishReason: response.finishReason,
            model: response.model,
            options: requestOptions,
            provider: response.provider,
            usage: response.usage,
            ...(joinRoutingDecision(attemptedRoutes)
              ? { routingDecision: joinRoutingDecision(attemptedRoutes) }
              : {}),
          }),
        );
        throwIfAborted(requestOptions.signal);
        return response;
      } catch (error) {
        throwIfAborted(requestOptions.signal);
        if (!shouldTryFallback(error) || index === plan.attempts.length - 1) {
          throw error;
        }
      }
    }

    throw new ProviderCapabilityError(
      'No model route attempts were available.',
    );
  }

  /** Resolves a conversation turn before context trimming and provider dispatch. */
  resolveContext(options: {
    budgetUsd?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    responseFormat?: ResponseFormat;
    sessionId?: string;
    system?: string;
    tenantId?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
  }): ConversationRoute {
    const requestOptions = withValidatedRequest(options as LLMRequestOptions);
    const plan = requestOptions.model
      ? {
          attempts: [
            {
              decision: `requested:${requestOptions.model}`,
              request: this.resolveRequest(requestOptions),
            },
          ],
        }
      : this.resolveRequestPlan(requestOptions);
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new ProviderCapabilityError(
        'No model route attempts were available.',
      );
    }

    const modelInfo = this.modelRegistry.get(attempt.request.model);
    return {
      attempts: plan.attempts.map((routeAttempt) => ({
        decision: routeAttempt.decision,
        model: routeAttempt.request.model,
        provider: routeAttempt.request.provider,
      })),
      contextWindow: modelInfo.contextWindow,
      model: attempt.request.model,
      provider: attempt.request.provider,
    };
  }

  /** Estimates completion cost using the same preflight calculation as budgets. */
  estimateRequest(options: LLMRequestOptions): RequestCostEstimate {
    const primaryAttempt = this.resolveRequestPlan(
      withValidatedRequest(options),
    ).attempts[0];
    if (!primaryAttempt) {
      throw new ProviderCapabilityError(
        'No model route attempts were available.',
      );
    }

    return this.estimateResolvedRequest(primaryAttempt.request);
  }

  private estimateResolvedRequest(
    resolved: LLMRequestOptions & {
      maxTokens: number;
      model: string;
      provider: CanonicalProvider;
    },
  ): RequestCostEstimate {
    const estimatedMessages = resolved.system
      ? [
          { content: resolved.system, role: 'system' as const },
          ...resolved.messages,
        ]
      : resolved.messages;
    const inputTokens = estimateMessageTokens(estimatedMessages);
    const maxOutputTokens = resolved.maxTokens;
    const reasoningTokens = estimateBillableReasoningTokens(resolved);
    const estimatedCostUSD = calcCostUSD(
      {
        ...(reasoningTokens > 0
          ? { billableReasoningTokens: reasoningTokens }
          : {}),
        inputTokens,
        model: resolved.model,
        outputTokens: maxOutputTokens,
      },
      this.modelRegistry,
    );

    return {
      estimatedCostUSD,
      inputTokens,
      maxOutputTokens,
      model: resolved.model,
      priceVersion: this.modelRegistry.get(resolved.model).lastUpdated,
      provider: resolved.provider,
      reasoningTokens,
    };
  }

  /** Executes a single non-streaming embedding request. */
  async embed(options: EmbeddingRequestOptions): Promise<EmbeddingResponse> {
    const resolved = this.resolveEmbeddingRequest(options);
    throwIfAborted(resolved.signal);
    return this.dispatchEmbed(resolved);
  }

  /** Executes a single non-streaming text-to-speech request. */
  async speak(options: SpeechRequestOptions): Promise<SpeechResponse> {
    const validated = validateSpeechRequest(options);
    throwIfAborted(validated.signal);
    const resolved = this.resolveSpeechRequest(validated);
    this.handleSpeechBudgetExceededAction(resolved, 'speech');
    const startedAt = Date.now();
    const response = await this.dispatchSpeak(resolved);
    throwIfAborted(resolved.signal);
    await this.logSpeechUsageEvent({
      durationMs: Date.now() - startedAt,
      kind: 'speech',
      model: response.model,
      options,
      provider: response.provider,
      usage: response.usage,
    });
    throwIfAborted(resolved.signal);
    return response;
  }

  /** Executes a single non-streaming speech-to-text request. */
  async transcribe(
    options: TranscriptionRequestOptions,
  ): Promise<TranscriptionResponse> {
    const validated = validateTranscriptionRequest(options);
    throwIfAborted(validated.signal);
    const resolved = this.resolveTranscriptionRequest(validated);
    this.handleSpeechBudgetExceededAction(resolved, 'transcription');
    const startedAt = Date.now();
    const response = await this.dispatchTranscribe(resolved);
    throwIfAborted(resolved.signal);
    await this.logSpeechUsageEvent({
      durationMs: Date.now() - startedAt,
      kind: 'transcription',
      model: response.model,
      options,
      provider: response.provider,
      usage: response.usage,
    });
    throwIfAborted(resolved.signal);
    return response;
  }

  /** Executes a streaming completion request and yields canonical chunks. */
  stream(options: LLMRequestOptions): CancelableStream<StreamChunk> {
    const requestOptions = withValidatedRequest(options);

    return createCancelableStream(
      (signal) => {
        throwIfAborted(signal);
        return this.streamWithFallback(
          this.resolveRequestPlan(requestOptions, { stream: true }),
          { ...requestOptions, signal },
          Date.now(),
        );
      },
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
    validateBudgetUsd(options.budgetUsd);
    const conversationOptions =
      options.tools === undefined
        ? options
        : {
            ...options,
            tools: validateAndCloneTools(
              options.tools,
              options.provider,
              options.model,
            ),
          };
    const store = this.sessionStore;
    if (store && conversationOptions.sessionId) {
      const stored = await store.get(
        conversationOptions.sessionId,
        conversationOptions.tenantId,
      );
      if (stored) {
        return Conversation.restore(this, stored.snapshot, {
          ...conversationOptions,
          ...(conversationOptions.budgetExceededAction !== undefined
            ? { budgetExceededAction: conversationOptions.budgetExceededAction }
            : { budgetExceededAction: this.budgetExceededAction }),
          ...(conversationOptions.onWarning !== undefined
            ? { onWarning: conversationOptions.onWarning }
            : { onWarning: this.onWarning }),
          ...(store ? { store } : {}),
        });
      }
    }

    return new Conversation(this, {
      ...conversationOptions,
      ...(conversationOptions.budgetExceededAction !== undefined
        ? { budgetExceededAction: conversationOptions.budgetExceededAction }
        : { budgetExceededAction: this.budgetExceededAction }),
      ...(conversationOptions.onWarning !== undefined
        ? { onWarning: conversationOptions.onWarning }
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

  /** Returns aggregated speech usage from the configured usage logger. */
  async getSpeechUsage(
    query: SpeechUsageQuery = {},
  ): Promise<SpeechUsageSummary> {
    if (!this.usageLogger?.getSpeechUsage) {
      throw new ProviderCapabilityError(
        'Speech usage aggregation requires a usage logger that implements getSpeechUsage(), such as PostgresUsageLogger.',
      );
    }

    return this.usageLogger.getSpeechUsage(query);
  }

  /** Returns aggregated usage serialized as JSON or CSV. */
  async exportUsage(
    format: UsageExportFormat,
    query: UsageQuery = {},
  ): Promise<string> {
    return exportUsageSummary(await this.getUsage(query), format);
  }

  /** Returns aggregated speech usage serialized as JSON or CSV. */
  async exportSpeechUsage(
    format: UsageExportFormat,
    query: SpeechUsageQuery = {},
  ): Promise<string> {
    return exportSpeechUsageSummary(await this.getSpeechUsage(query), format);
  }

  /** Returns the session store configured on this client, if any. */
  getSessionStore(): SessionStore<ConversationSnapshot> | undefined {
    return this.sessionStore;
  }

  private getAnthropicAdapter(model?: string): AnthropicAdapter {
    if (!this.anthropicAdapter) {
      throw new AuthenticationError(
        'Anthropic API key is missing. Populate ANTHROPIC_API_KEY in .env or pass anthropicApiKey to LLMClient.',
        {
          ...(model !== undefined ? { model } : {}),
          provider: 'anthropic',
        },
      );
    }

    return this.anthropicAdapter;
  }

  private getGeminiAdapter(model?: string): GeminiAdapter {
    if (!this.geminiAdapter) {
      throw new AuthenticationError(
        'Gemini API key is missing. Populate GEMINI_API_KEY in .env or pass geminiApiKey to LLMClient.',
        {
          ...(model !== undefined ? { model } : {}),
          provider: 'google',
        },
      );
    }

    return this.geminiAdapter;
  }

  private getOpenAIAdapter(model?: string): OpenAIAdapter {
    if (!this.openaiAdapter) {
      throw new AuthenticationError(
        'OpenAI API key is missing. Populate OPENAI_API_KEY in .env or pass openaiApiKey to LLMClient.',
        {
          ...(model !== undefined ? { model } : {}),
          provider: 'openai',
        },
      );
    }

    return this.openaiAdapter;
  }

  private async listRemoteModels(
    options: RemoteModelListOptions,
  ): Promise<RemoteModelInfo[]> {
    switch (options.provider) {
      case 'anthropic':
        return this.getAnthropicAdapter().listModels();
      case 'google':
        return this.getGeminiAdapter().listModels();
      case 'openai':
        return this.getOpenAIAdapter().listModels();
    }
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

  private dispatchEmbed(
    resolved: EmbeddingRequestOptions & {
      model: string;
      provider: EmbeddingProvider;
    },
  ): Promise<EmbeddingResponse> {
    switch (resolved.provider) {
      case 'google':
        return this.getGeminiAdapter(resolved.model).embed(resolved);
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

  private dispatchSpeak(
    resolved: SpeechRequestOptions & {
      model: string;
      provider: SpeechProvider;
    },
  ): Promise<SpeechResponse> {
    switch (resolved.provider) {
      case 'openai':
        return this.getOpenAIAdapter(resolved.model).speak({
          ...resolved,
          provider: 'openai',
        });
      default:
        throw new ProviderCapabilityError(
          `Provider "${resolved.provider}" is not implemented for text-to-speech in this client yet.`,
          {
            model: resolved.model,
            provider: resolved.provider,
          },
        );
    }
  }

  private dispatchTranscribe(
    resolved: TranscriptionRequestOptions & {
      model: string;
      provider: SpeechProvider;
    },
  ): Promise<TranscriptionResponse> {
    switch (resolved.provider) {
      case 'openai':
        return this.getOpenAIAdapter(resolved.model).transcribe({
          ...resolved,
          provider: 'openai',
        });
      default:
        throw new ProviderCapabilityError(
          `Provider "${resolved.provider}" is not implemented for speech-to-text in this client yet.`,
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
    resolveOptions: { stream?: boolean } = {},
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
      target.provider ??
      options.provider ??
      this.defaultProvider ??
      modelInfo.provider;

    if (provider !== modelInfo.provider) {
      throw new ProviderCapabilityError(
        `Model "${model}" belongs to provider "${modelInfo.provider}", but request asked for "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    assertResponseFormatSupported(
      modelInfo,
      options.responseFormat,
      resolveOptions,
    );

    return {
      ...options,
      maxTokens: options.maxTokens ?? 1024,
      model,
      provider,
    };
  }

  private resolveEmbeddingRequest(
    options: EmbeddingRequestOptions,
  ): EmbeddingRequestOptions & {
    model: string;
    provider: EmbeddingProvider;
  } {
    const model = normalizeEmbeddingModelId(
      options.model ?? this.defaultEmbeddingModel ?? 'gemini-embedding-2',
    );
    const requestedProvider = options.provider as CanonicalProvider | undefined;
    if (requestedProvider && requestedProvider !== 'google') {
      throw new ProviderCapabilityError(
        `Embeddings currently support provider "google" only in v1. Received "${requestedProvider}".`,
        {
          model,
          provider: requestedProvider,
        },
      );
    }

    const modelInfo = this.modelRegistry.assertModelKind(model, 'embedding');
    const provider =
      options.provider ??
      this.defaultEmbeddingProvider ??
      (modelInfo.provider as EmbeddingProvider);

    if (provider !== 'google') {
      throw new ProviderCapabilityError(
        `Embeddings currently support provider "google" only in v1. Received "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    if (provider !== modelInfo.provider) {
      throw new ProviderCapabilityError(
        `Model "${model}" belongs to provider "${modelInfo.provider}", but embedding request asked for "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    validateEmbeddingRequest(options, {
      model,
      modelInfo,
      provider,
    });

    return {
      ...options,
      model,
      provider,
    };
  }

  private resolveSpeechRequest(
    options: SpeechRequestOptions,
  ): SpeechRequestOptions & {
    model: string;
    provider: SpeechProvider;
  } {
    const model = options.model ?? 'gpt-4o-mini-tts';
    const modelInfo = this.modelRegistry.assertModelKind(model, 'speech');
    const provider = options.provider ?? (modelInfo.provider as SpeechProvider);

    if (provider !== 'openai') {
      throw new ProviderCapabilityError(
        `Text-to-speech currently supports provider "openai" only in v1. Received "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    if (provider !== modelInfo.provider) {
      throw new ProviderCapabilityError(
        `Model "${model}" belongs to provider "${modelInfo.provider}", but speech request asked for "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    if (options.input.length === 0) {
      throw new ProviderCapabilityError(
        'Text-to-speech input cannot be empty.',
        {
          model,
          provider,
        },
      );
    }

    return {
      ...options,
      model,
      provider,
    };
  }

  private resolveTranscriptionRequest(
    options: TranscriptionRequestOptions,
  ): TranscriptionRequestOptions & {
    model: string;
    provider: SpeechProvider;
  } {
    const model = options.model ?? 'gpt-4o-mini-transcribe';
    const modelInfo = this.modelRegistry.assertModelKind(
      model,
      'transcription',
    );
    const provider = options.provider ?? (modelInfo.provider as SpeechProvider);

    if (provider !== 'openai') {
      throw new ProviderCapabilityError(
        `Speech-to-text currently supports provider "openai" only in v1. Received "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    if (provider !== modelInfo.provider) {
      throw new ProviderCapabilityError(
        `Model "${model}" belongs to provider "${modelInfo.provider}", but transcription request asked for "${provider}".`,
        {
          model,
          provider,
        },
      );
    }

    return {
      ...options,
      model,
      provider,
    };
  }

  private resolveRequestPlan(
    options: LLMRequestOptions,
    resolveOptions: { stream?: boolean } = {},
  ): {
    attempts: Array<{
      decision: string;
      request: LLMRequestOptions & {
        maxTokens: number;
        model: string;
        provider: CanonicalProvider;
      };
    }>;
  } {
    const { resolvedRoute: pinnedRoute, ...requestOptions } =
      options as InternalLLMRequestOptions;
    const resolvedRoute = pinnedRoute
      ? {
          attempts:
            pinnedRoute.attempts && pinnedRoute.attempts.length > 0
              ? pinnedRoute.attempts
              : [
                  {
                    decision: `resolved:${pinnedRoute.model}`,
                    model: pinnedRoute.model,
                    provider: pinnedRoute.provider,
                  },
                ],
        }
      : this.resolveRoute(requestOptions, resolveOptions);
    return {
      attempts: resolvedRoute.attempts.map((attempt) => ({
        decision: attempt.decision,
        request: this.resolveRequest(requestOptions, attempt, resolveOptions),
      })),
    };
  }

  private resolveRoute(
    options: LLMRequestOptions,
    resolveOptions: { stream?: boolean } = {},
  ): ResolvedModelRoute {
    if (!this.modelRouter) {
      const directRequest = this.resolveRequest(options, {}, resolveOptions);
      const decision = options.model
        ? `requested:${directRequest.model}`
        : `default:${directRequest.model}`;
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
      ...(this.defaultModel !== undefined
        ? { defaultModel: this.defaultModel }
        : {}),
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
      ...(options.provider !== undefined
        ? { requestedProvider: options.provider }
        : {}),
      ...(options.sessionId !== undefined
        ? { sessionId: options.sessionId }
        : {}),
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options.toolChoice !== undefined
        ? { toolChoice: options.toolChoice }
        : {}),
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

    const estimate = this.estimateResolvedRequest(options);
    const estimatedInputTokens = estimate.inputTokens;
    const estimatedOutputTokens = estimate.maxOutputTokens;
    const estimatedReasoningTokens = estimate.reasoningTokens;
    const estimatedCostUSD = estimate.estimatedCostUSD;

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
          ...(estimatedReasoningTokens > 0 ? { estimatedReasoningTokens } : {}),
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

  private handleSpeechBudgetExceededAction(
    options:
      | (SpeechRequestOptions & { model: string; provider: SpeechProvider })
      | (TranscriptionRequestOptions & {
          model: string;
          provider: SpeechProvider;
        }),
    kind: 'speech' | 'transcription',
  ): void {
    if (options.budgetUsd === undefined) {
      return;
    }

    const model = this.modelRegistry.get(options.model);
    const speechPrices = model.speechPrices;
    if (!speechPrices) {
      throw new BudgetExceededError(
        `Cannot preflight ${kind} budget for "${options.model}" because speech pricing metadata is missing.`,
        {
          model: options.model,
          provider: options.provider,
        },
      );
    }

    if (kind === 'speech') {
      const speechOptions = options as SpeechRequestOptions & {
        model: string;
        provider: SpeechProvider;
      };
      const outputAudioSeconds =
        speechOptions.estimatedOutputSeconds ?? speechOptions.maxOutputSeconds;
      if (
        speechPrices.outputAudioSecondPrice !== undefined &&
        outputAudioSeconds === undefined
      ) {
        throw new BudgetExceededError(
          'Speech budget preflight requires estimatedOutputSeconds or maxOutputSeconds when output audio duration affects cost.',
          {
            model: options.model,
            provider: options.provider,
          },
        );
      }

      const estimatedCost = calcSpeechCostUSD(
        {
          estimated: true,
          inputCharacters: speechOptions.input.length,
          inputTokens: estimateTokens(speechOptions.input),
          model: options.model,
          ...(outputAudioSeconds !== undefined ? { outputAudioSeconds } : {}),
        },
        this.modelRegistry,
      );
      this.throwIfSpeechBudgetExceeded(options, estimatedCost.costUSD);
      return;
    }

    const transcriptionOptions = options as TranscriptionRequestOptions & {
      model: string;
      provider: SpeechProvider;
    };
    if (
      speechPrices.inputAudioSecondPrice !== undefined &&
      transcriptionOptions.inputAudioSeconds === undefined
    ) {
      throw new BudgetExceededError(
        'Transcription budget preflight requires inputAudioSeconds when audio duration affects cost.',
        {
          model: options.model,
          provider: options.provider,
        },
      );
    }

    const estimatedCost = calcSpeechCostUSD(
      {
        estimated: true,
        ...(transcriptionOptions.inputAudioSeconds !== undefined
          ? { inputAudioSeconds: transcriptionOptions.inputAudioSeconds }
          : {}),
        model: options.model,
      },
      this.modelRegistry,
    );
    this.throwIfSpeechBudgetExceeded(options, estimatedCost.costUSD);
  }

  private throwIfSpeechBudgetExceeded(
    options: {
      budgetExceededAction?: BudgetExceededAction;
      budgetUsd?: number;
      model: string;
      provider: SpeechProvider;
    },
    estimatedCostUSD: number | undefined,
  ): void {
    if (options.budgetUsd === undefined || estimatedCostUSD === undefined) {
      return;
    }

    if (estimatedCostUSD <= options.budgetUsd) {
      return;
    }

    const error = new BudgetExceededError(
      `Estimated speech request cost ${formatCost(estimatedCostUSD)} exceeds the budget of ${formatCost(
        options.budgetUsd,
      )}.`,
      {
        details: {
          budgetUsd: options.budgetUsd,
          estimatedCostUSD,
        },
        model: options.model,
        provider: options.provider,
      },
    );

    const action = options.budgetExceededAction ?? this.budgetExceededAction;
    if (action === 'warn') {
      this.onWarning(error.message);
      return;
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

  private async logSpeechUsageEvent(input: {
    durationMs: number;
    kind: 'speech' | 'transcription';
    model: string;
    options: SpeechRequestOptions | TranscriptionRequestOptions;
    provider: SpeechProvider;
    usage: SpeechResponse['usage'] | TranscriptionResponse['usage'] | undefined;
  }): Promise<void> {
    if (!this.usageLogger || !('logSpeech' in this.usageLogger)) {
      return;
    }

    const logSpeech = this.usageLogger.logSpeech;
    if (typeof logSpeech !== 'function') {
      return;
    }

    try {
      await logSpeech.call(this.usageLogger, {
        durationMs: input.durationMs,
        kind: input.kind,
        model: input.model,
        provider: input.provider,
        speechUsage: input.usage ?? { estimated: true },
        timestamp: new Date().toISOString(),
        ...(input.options.botId !== undefined
          ? { botId: input.options.botId }
          : {}),
        ...(input.options.sessionId !== undefined
          ? { sessionId: input.options.sessionId }
          : {}),
        ...(input.options.tenantId !== undefined
          ? { tenantId: input.options.tenantId }
          : {}),
      });
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
    let sequence = 0;

    const decorate = (chunk: StreamChunk): StreamChunk => ({
      ...chunk,
      ...(options.requestId !== undefined
        ? { requestId: options.requestId }
        : {}),
      sequence: ++sequence,
      timestamp: new Date().toISOString(),
      version: chunk.version ?? STREAM_EVENT_VERSION,
    });

    for (const [index, attempt] of plan.attempts.entries()) {
      throwIfAborted(options.signal);
      attemptedRoutes.push(attempt.decision);
      let emittedUserVisibleChunk = false;

      try {
        const budgetDecision = this.handleBudgetExceededAction(attempt.request);
        if (budgetDecision.action === 'skip') {
          const skipped = buildBudgetSkipResponse(
            budgetDecision.error,
            attempt.request,
          );
          yield decorate({ delta: skipped.text, type: 'text-delta' });
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
          yield decorate({
            finishReason: skipped.finishReason,
            type: 'done',
            usage: skipped.usage,
          });
          return;
        }

        yield decorate({
          model: attempt.request.model,
          provider: attempt.request.provider,
          type: 'response-start',
        });

        for await (const chunk of this.dispatchStream(attempt.request)) {
          throwIfAborted(options.signal);
          if (
            chunk.type === 'text-delta' ||
            chunk.type === 'tool-call-start' ||
            chunk.type === 'tool-call-delta' ||
            chunk.type === 'tool-call-arguments' ||
            chunk.type === 'tool-call-result'
          ) {
            emittedUserVisibleChunk = true;
          }

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
            yield decorate({ type: 'usage-update', usage: chunk.usage });
          }

          yield decorate(chunk);
        }

        return;
      } catch (error) {
        throwIfAborted(options.signal);
        if (
          emittedUserVisibleChunk ||
          !shouldTryFallback(error) ||
          index === plan.attempts.length - 1
        ) {
          throw error;
        }

        yield decorate({
          attempt: index + 1,
          ...(error instanceof Error ? { error } : {}),
          type: 'retry',
        });
      }
    }
  }
}

class MockLLMClient extends LLMClient {
  private readonly embeddingQueue: NonNullable<
    MockLLMClientOptions['embeddings']
  >;
  private readonly mockDefaultModel: string;
  private readonly mockDefaultEmbeddingModel: string;
  private readonly mockDefaultEmbeddingProvider: EmbeddingProvider;
  private readonly mockDefaultProvider: CanonicalProvider;
  private readonly responseQueue: NonNullable<
    MockLLMClientOptions['responses']
  >;
  private readonly speechQueue: NonNullable<MockLLMClientOptions['speeches']>;
  private readonly streamQueue: NonNullable<MockLLMClientOptions['streams']>;
  private readonly transcriptionQueue: NonNullable<
    MockLLMClientOptions['transcriptions']
  >;

  constructor(options: MockLLMClientOptions = {}) {
    const defaultModel = options.defaultModel ?? 'mock-model';
    const defaultEmbeddingModel =
      options.defaultEmbeddingModel ?? 'mock-embedding-model';
    const defaultEmbeddingProvider = options.defaultEmbeddingProvider ?? 'mock';
    const defaultProvider = options.defaultProvider ?? 'mock';
    super({
      ...options,
      defaultEmbeddingModel,
      defaultEmbeddingProvider,
      defaultModel,
      defaultProvider,
    });
    this.embeddingQueue = [...(options.embeddings ?? [])];
    this.mockDefaultEmbeddingModel = defaultEmbeddingModel;
    this.mockDefaultEmbeddingProvider = defaultEmbeddingProvider;
    this.mockDefaultModel = defaultModel;
    this.mockDefaultProvider = defaultProvider;
    this.responseQueue = [...(options.responses ?? [])];
    this.speechQueue = [...(options.speeches ?? [])];
    this.streamQueue = [...(options.streams ?? [])];
    this.transcriptionQueue = [...(options.transcriptions ?? [])];
  }

  override resolveContext(options: {
    budgetUsd?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    responseFormat?: ResponseFormat;
    sessionId?: string;
    system?: string;
    tenantId?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
  }): ConversationRoute {
    const requestOptions = withValidatedRequest(options as LLMRequestOptions);
    try {
      return super.resolveContext(requestOptions);
    } catch {
      const model = requestOptions.model ?? this.mockDefaultModel;
      const provider = requestOptions.provider ?? this.mockDefaultProvider;
      let contextWindow: number | undefined;
      try {
        contextWindow = this.models.get(model).contextWindow;
      } catch {
        // Mock-only models do not need registry entries.
      }
      return {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        model,
        provider,
      };
    }
  }

  override async embed(
    options: EmbeddingRequestOptions,
  ): Promise<EmbeddingResponse> {
    const resolved = this.resolveMockEmbeddingRequest(options);
    let modelInfo;
    try {
      modelInfo = this.models.get(resolved.model);
    } catch {
      // Mock-only embedding models do not need registry entries.
    }
    validateEmbeddingRequest(resolved, {
      model: resolved.model,
      ...(modelInfo ? { modelInfo } : {}),
      provider: resolved.provider,
    });
    throwIfAborted(resolved.signal);
    const next = this.embeddingQueue.shift();

    if (!next) {
      throw new MockQueueExhaustedError('embed', resolved);
    }

    return typeof next === 'function' ? await next(resolved) : next;
  }

  override async complete(
    options: LLMRequestOptions,
  ): Promise<CanonicalResponse> {
    const validated = withValidatedRequest(options);
    throwIfAborted(validated.signal);
    const resolved = this.resolveMockRequest(validated);
    const next = this.responseQueue.shift();

    if (!next) {
      throw new MockQueueExhaustedError('complete', resolved);
    }

    const response = typeof next === 'function' ? await next(resolved) : next;
    return parseStructuredOutput(response, resolved.responseFormat);
  }

  override async speak(options: SpeechRequestOptions): Promise<SpeechResponse> {
    const validated = validateSpeechRequest(options);
    throwIfAborted(validated.signal);
    const resolved = this.resolveMockSpeechRequest(validated);
    const next = this.speechQueue.shift();

    if (!next) {
      throw new MockQueueExhaustedError('speak', resolved);
    }

    return typeof next === 'function' ? await next(resolved) : next;
  }

  override async transcribe(
    options: TranscriptionRequestOptions,
  ): Promise<TranscriptionResponse> {
    const validated = validateTranscriptionRequest(options);
    throwIfAborted(validated.signal);
    const resolved = this.resolveMockTranscriptionRequest(validated);
    const next = this.transcriptionQueue.shift();

    if (!next) {
      throw new MockQueueExhaustedError('transcribe', resolved);
    }

    return typeof next === 'function' ? await next(resolved) : next;
  }

  override stream(options: LLMRequestOptions): CancelableStream<StreamChunk> {
    const requestOptions = withValidatedRequest(options);
    return createCancelableStream(
      async function* (
        this: MockLLMClient,
        signal: AbortSignal,
      ): AsyncGenerator<StreamChunk, void, void> {
        throwIfAborted(signal);
        const resolved = this.resolveMockRequest({
          ...requestOptions,
          signal,
        });
        const next = this.streamQueue.shift();
        let sequence = 0;
        const decorate = (chunk: StreamChunk): StreamChunk => ({
          ...chunk,
          ...(requestOptions.requestId !== undefined
            ? { requestId: requestOptions.requestId }
            : {}),
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          version: chunk.version ?? STREAM_EVENT_VERSION,
        });

        yield decorate({
          model: resolved.model,
          provider: resolved.provider,
          type: 'response-start',
        });

        if (!next) {
          throw new MockQueueExhaustedError('stream', resolved);
        }

        const stream = typeof next === 'function' ? await next(resolved) : next;

        if (isAsyncIterable(stream)) {
          for await (const chunk of stream) {
            if (chunk.type === 'done') {
              yield decorate({ type: 'usage-update', usage: chunk.usage });
            }
            yield decorate(chunk);
          }
          return;
        }

        for (const chunk of stream) {
          if (chunk.type === 'done') {
            yield decorate({ type: 'usage-update', usage: chunk.usage });
          }
          yield decorate(chunk);
        }
      }.bind(this),
      requestOptions.signal,
    );
  }

  private resolveMockRequest(options: LLMRequestOptions): LLMRequestOptions & {
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

  private resolveMockEmbeddingRequest(
    options: EmbeddingRequestOptions,
  ): EmbeddingRequestOptions & {
    model: string;
    provider: EmbeddingProvider;
  } {
    return {
      ...options,
      model: normalizeEmbeddingModelId(
        options.model ?? this.mockDefaultEmbeddingModel,
      ),
      provider: options.provider ?? this.mockDefaultEmbeddingProvider,
    };
  }

  private resolveMockSpeechRequest(
    options: SpeechRequestOptions,
  ): SpeechRequestOptions & {
    model: string;
    provider: SpeechProvider;
  } {
    return {
      ...options,
      model: options.model ?? 'mock-speech-model',
      provider: options.provider ?? 'mock',
    };
  }

  private resolveMockTranscriptionRequest(
    options: TranscriptionRequestOptions,
  ): TranscriptionRequestOptions & {
    model: string;
    provider: SpeechProvider;
  } {
    return {
      ...options,
      model: options.model ?? 'mock-transcription-model',
      provider: options.provider ?? 'mock',
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

function normalizeEmbeddingModelId(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
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

function isAsyncIterable(
  value: AsyncIterable<StreamChunk> | StreamChunk[],
): value is AsyncIterable<StreamChunk> {
  return (
    typeof (value as AsyncIterable<StreamChunk>)[Symbol.asyncIterator] ===
    'function'
  );
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
    ...(input.options.botId !== undefined
      ? { botId: input.options.botId }
      : {}),
    ...(input.options.metadata !== undefined
      ? { metadata: input.options.metadata }
      : {}),
    ...(input.options.requestId !== undefined
      ? { requestId: input.options.requestId }
      : {}),
    ...(input.routingDecision
      ? { routingDecision: input.routingDecision }
      : {}),
    ...(input.options.sessionId !== undefined
      ? { sessionId: input.options.sessionId }
      : {}),
    ...(input.options.tenantId !== undefined
      ? { tenantId: input.options.tenantId }
      : {}),
  };
}

function withValidatedRequest(options: LLMRequestOptions): LLMRequestOptions {
  validateBudgetUsd((options as { budgetUsd?: unknown }).budgetUsd);
  validateCompletionCacheOptions({
    messages: options.messages,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.providerOptions !== undefined
      ? { providerOptions: options.providerOptions }
      : {}),
  });
  const metadata =
    options.metadata === undefined
      ? undefined
      : validateAndCloneMetadata(options.metadata);
  const tools =
    options.tools === undefined
      ? undefined
      : validateAndCloneTools(options.tools, options.provider, options.model);
  if (metadata === undefined && tools === undefined) {
    return options;
  }
  return {
    ...options,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

function estimateBillableReasoningTokens(options: {
  provider: CanonicalProvider;
  providerOptions?: ProviderOptions;
}): number {
  if (options.provider !== 'google') {
    return 0;
  }

  const thinkingBudget =
    options.providerOptions?.google?.thinking?.budgetTokens;
  if (thinkingBudget === undefined || thinkingBudget <= 0) {
    return 0;
  }

  return thinkingBudget;
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
