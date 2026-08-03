import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from 'unified-llm-client/errors';
import { validateEmbeddingRequest } from '../embedding-validation.js';
import { ModelRegistry } from 'unified-llm-client/models';
import {
  discoveryError,
  isPlainObject,
  readModelDiscoveryPage,
  readOptionalFiniteNumber,
  readOptionalString,
  readOptionalStringArray,
  readPaginationCursor,
  readRequiredModelId,
} from '../model-discovery.js';
import { geminiUsageToCanonical, usageWithCost } from '../utils/cost.js';
import {
  assertProviderArray,
  assertProviderContentType,
  assertProviderObject,
  assertProviderString,
  assertProviderUsage,
  invalidProviderResponse,
  parseProviderEvent,
  parseSSE,
  readProviderJson,
  throwIfAborted,
  withRetry,
} from '#provider-runtime';
import {
  validateAndCloneTool,
  validateAndCloneTools,
} from '../tool-validation.js';
import {
  buildGeminiResponseFormat,
  usesGeminiResponseFormatEnvelope,
} from '../structured-output.js';
import {
  attachGoogleReplayState,
  getGoogleReplayStateForMessage,
} from '../internal/provider-replay-state.js';

import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalPart,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
  CanonicalToolSchema,
  EmbeddingInputItem,
  EmbeddingProviderOptions,
  EmbeddingPurpose,
  EmbeddingRequestOptions,
  EmbeddingResponse,
  EmbeddingUsageMetrics,
  JsonObject,
  JsonValue,
  ProviderOptions,
  RemoteModelInfo,
  ResponseFormat,
  StreamChunk,
} from '../types.js';
import type { GeminiErrorDetail, RetryOptions } from '../utils/retry.js';

type GeminiRole = 'model' | 'user';

type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

interface GeminiTextPart {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
}

interface GeminiInlineDataPart {
  inlineData: {
    data: string;
    mimeType: string;
  };
}

interface GeminiFileDataPart {
  fileData: {
    fileUri: string;
    mimeType: string;
  };
}

interface GeminiFunctionCallPart {
  functionCall: {
    args: JsonObject;
    id?: string;
    name: string;
  };
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    id?: string;
    name: string;
    response: JsonObject;
  };
}

interface GeminiContent {
  parts: GeminiPart[];
  role?: GeminiRole;
}

interface GeminiToolSchema {
  additionalProperties?: boolean;
  description?: string;
  enum?: readonly (boolean | null | number | string)[];
  items?: GeminiToolSchema;
  properties?: Record<string, GeminiToolSchema>;
  required?: readonly string[];
  type: Uppercase<CanonicalToolSchema['type']>;
}

interface GeminiFunctionDeclaration {
  description: string;
  name: string;
  parameters: GeminiToolSchema;
}

interface GeminiToolDefinition {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiToolConfig {
  functionCallingConfig: {
    allowedFunctionNames?: string[];
    mode: 'ANY' | 'AUTO' | 'NONE';
  };
}

interface GeminiUsageMetadata {
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  promptTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

type GeminiFinishReason =
  | 'BLOCKLIST'
  | 'LANGUAGE'
  | 'MALFORMED_FUNCTION_CALL'
  | 'MAX_TOKENS'
  | 'OTHER'
  | 'PROHIBITED_CONTENT'
  | 'RECITATION'
  | 'SAFETY'
  | 'SPII'
  | 'STOP'
  | null;

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: GeminiFinishReason;
  index: number;
  safetyRatings?: Array<{
    blocked?: boolean;
    category?: string;
    probability?: string;
  }>;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  modelVersion?: string;
  promptFeedback?: {
    blockReason?: string;
  };
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiEmbeddingPayload {
  values: number[];
}

interface GeminiEmbedContentResponse {
  embedding?: GeminiEmbeddingPayload;
  embeddings?: GeminiEmbeddingPayload[];
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiCachedContent {
  contents?: GeminiContent[];
  createTime?: string;
  displayName?: string;
  expireTime?: string;
  model: string;
  name: string;
  systemInstruction?: GeminiContent;
  toolConfig?: GeminiToolConfig;
  tools?: GeminiToolDefinition[];
  ttl?: string;
  updateTime?: string;
  usageMetadata?: GeminiUsageMetadata;
}

export interface GeminiCachedContentPage {
  cachedContents: GeminiCachedContent[];
  nextPageToken?: string;
}

interface GeminiErrorBody {
  error?: {
    code?: number;
    details?: GeminiErrorDetail[];
    message?: string;
    status?: string;
  };
}

export interface GeminiClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  modelRegistry?: ModelRegistry;
  retryOptions?: RetryOptions;
}

export interface GeminiCompletionOptions {
  maxTokens?: number;
  messages: CanonicalMessage[];
  model: string;
  providerOptions?: ProviderOptions;
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  system?: string;
  temperature?: number;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

export interface GeminiEmbeddingOptions extends Pick<
  EmbeddingRequestOptions,
  | 'botId'
  | 'dimensions'
  | 'input'
  | 'providerOptions'
  | 'purpose'
  | 'signal'
  | 'tenantId'
> {
  model: string;
}

export interface GeminiCreateCacheOptions {
  displayName?: string;
  expireTime?: string;
  messages?: CanonicalMessage[];
  model: string;
  system?: string;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
  ttl?: string;
}

export interface GeminiListCachesOptions {
  pageSize?: number;
  pageToken?: string;
}

export interface GeminiUpdateCacheOptions {
  expireTime?: string;
  ttl?: string;
}

export class GeminiAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly modelRegistry: ModelRegistry;
  private readonly retryOptions: RetryOptions | undefined;

  constructor(config: GeminiClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl =
      config.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
    this.retryOptions = config.retryOptions;
  }

  async complete(options: GeminiCompletionOptions): Promise<CanonicalResponse> {
    this.assertCapabilities(options);
    throwIfAborted(options.signal);

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`,
          buildRequestInit(
            {
              body: JSON.stringify(translateGeminiRequest(options)),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
      options.signal,
    );

    if (!response.ok) {
      throw await mapGeminiError(response, options.model);
    }

    const context = geminiResponseContext(response, options, 'complete');
    const payload = await readProviderJson(response, context);
    validateGeminiResponsePayload(payload, context);
    return translateGeminiResponse(payload, options.model, this.modelRegistry);
  }

  async embed(options: GeminiEmbeddingOptions): Promise<EmbeddingResponse> {
    const model = normalizeGeminiModelId(options.model);
    const modelInfo = this.modelRegistry.assertModelKind(model, 'embedding');
    const requests = validateEmbeddingRequest(options, {
      model,
      modelInfo,
      provider: 'google',
    });
    throwIfAborted(options.signal);

    const embeddings: EmbeddingResponse['embeddings'] = [];
    let lastPayload: GeminiEmbedContentResponse | undefined;
    let totalPromptTokens = 0;
    let observedPromptTokens = false;

    for (const [index, input] of requests.entries()) {
      throwIfAborted(options.signal);
      const response = await withRetry(
        async () =>
          this.fetchImplementation(
            `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:embedContent`,
            buildRequestInit(
              {
                body: JSON.stringify(
                  translateGeminiEmbeddingRequest(options, input),
                ),
                headers: this.buildHeaders(),
                method: 'POST',
              },
              options.signal,
            ),
          ),
        this.retryOptions,
        options.signal,
      );

      if (!response.ok) {
        throw await mapGeminiError(response, options.model);
      }

      const context = geminiResponseContext(response, options, 'embed');
      const payload = await readProviderJson(response, context);
      validateGeminiEmbeddingPayload(payload, context);
      throwIfAborted(options.signal);
      const translated = translateGeminiEmbeddingResponse(
        payload,
        options.model,
        this.modelRegistry,
      );
      embeddings.push({
        index,
        values: translated.embeddings[0]?.values ?? [],
      });
      lastPayload = payload;
      if (payload.usageMetadata?.promptTokenCount !== undefined) {
        totalPromptTokens += payload.usageMetadata.promptTokenCount;
        observedPromptTokens = true;
      }
    }

    if (embeddings.some((item) => item.values.length === 0)) {
      throw new ProviderError(
        'Gemini embedding response contained no embedding values.',
        {
          model: options.model,
          provider: 'google',
        },
      );
    }

    const usage = buildGeminiEmbeddingUsage(
      modelInfo,
      observedPromptTokens
        ? { promptTokenCount: totalPromptTokens }
        : undefined,
    );

    return {
      embeddings,
      model: options.model,
      provider: 'google',
      raw: lastPayload ?? null,
      ...(usage ? { usage } : {}),
    };
  }

  async *stream(
    options: GeminiCompletionOptions,
  ): AsyncGenerator<StreamChunk, void, void> {
    this.assertCapabilities({ ...options, stream: true });
    throwIfAborted(options.signal);

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`,
          buildRequestInit(
            {
              body: JSON.stringify(translateGeminiRequest(options)),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
      options.signal,
    );

    if (!response.ok) {
      throw await mapGeminiError(response, options.model);
    }

    if (!response.body) {
      throw new ProviderError(
        'Gemini streaming response did not include a body.',
        {
          model: options.model,
          provider: 'google',
        },
      );
    }

    const context = geminiResponseContext(response, options, 'stream');
    assertProviderContentType(response, context, 'sse');
    const assembler = new GeminiStreamAssembler(
      options.model,
      this.modelRegistry,
      options.providerOptions?.google?.thinking?.includeThoughts === true,
      context,
    );
    for await (const payload of parseSSE(response.body, options.signal)) {
      throwIfAborted(options.signal);
      const chunk = parseProviderEvent(payload, context);
      validateGeminiResponsePayload(chunk, context, true);
      yield* assembler.consume(chunk);
    }

    throwIfAborted(options.signal);
    yield* assembler.finish();
  }

  async createCache(
    options: GeminiCreateCacheOptions,
  ): Promise<GeminiCachedContent> {
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1beta/cachedContents`,
          buildRequestInit(
            {
              body: JSON.stringify(translateGeminiCacheCreateRequest(options)),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            undefined,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapGeminiError(response, options.model);
    }

    return (await response.json()) as GeminiCachedContent;
  }

  async getCache(name: string): Promise<GeminiCachedContent> {
    const normalizedName = normalizeGeminiCachedContentName(name);
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1beta/${normalizedName}`,
          buildRequestInit(
            {
              headers: this.buildHeaders(),
              method: 'GET',
            },
            undefined,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapGeminiError(response);
    }

    return (await response.json()) as GeminiCachedContent;
  }

  async listCaches(
    options: GeminiListCachesOptions = {},
  ): Promise<GeminiCachedContentPage> {
    const searchParams = new URLSearchParams();
    if (options.pageSize !== undefined) {
      searchParams.set('pageSize', String(options.pageSize));
    }
    if (options.pageToken) {
      searchParams.set('pageToken', options.pageToken);
    }

    const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : '';
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1beta/cachedContents${suffix}`,
          buildRequestInit(
            {
              headers: this.buildHeaders(),
              method: 'GET',
            },
            undefined,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapGeminiError(response);
    }

    return (await response.json()) as GeminiCachedContentPage;
  }

  async listModels(): Promise<RemoteModelInfo[]> {
    const models: RemoteModelInfo[] = [];
    let pageToken: string | undefined;
    const seenCursors = new Set<string>();

    while (true) {
      const searchParams = new URLSearchParams({
        pageSize: '100',
      });
      if (pageToken) {
        searchParams.set('pageToken', pageToken);
      }

      const response = await withRetry(
        async () =>
          this.fetchImplementation(
            `${this.baseUrl}/v1beta/models?${searchParams.toString()}`,
            buildRequestInit(
              {
                headers: this.buildHeaders(),
                method: 'GET',
              },
              undefined,
            ),
          ),
        this.retryOptions,
      );

      if (!response.ok) {
        throw await mapGeminiError(response);
      }

      const { page, records } = await readModelDiscoveryPage(
        response,
        'google',
        'models',
      );
      for (const model of records) {
        const providerId = readRequiredModelId(model, 'name');
        if (!providerId || !isPlainObject(model)) {
          continue;
        }
        const displayName = readOptionalString(model, 'displayName');
        const inputTokenLimit = readOptionalFiniteNumber(
          model,
          'inputTokenLimit',
        );
        const outputTokenLimit = readOptionalFiniteNumber(
          model,
          'outputTokenLimit',
        );
        const supportedActions = readOptionalStringArray(
          model,
          'supportedGenerationMethods',
        );
        models.push({
          ...(displayName ? { displayName } : {}),
          id: normalizeGeminiModelId(providerId),
          ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
          ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
          provider: 'google',
          providerId,
          raw: model,
          ...(supportedActions ? { supportedActions } : {}),
        });
      }

      if (!Object.prototype.hasOwnProperty.call(page, 'nextPageToken')) {
        return models;
      }

      if (page.nextPageToken === undefined) {
        return models;
      }
      if (page.nextPageToken === null) {
        throw discoveryError('google', 'nextPageToken', 'non_empty_string');
      }
      pageToken = readPaginationCursor(
        page.nextPageToken,
        seenCursors,
        'google',
        'nextPageToken',
      );
    }
  }

  async updateCache(
    name: string,
    options: GeminiUpdateCacheOptions,
  ): Promise<GeminiCachedContent> {
    const normalizedName = normalizeGeminiCachedContentName(name);
    const translated = translateGeminiCacheUpdateRequest(options);
    const searchParams = new URLSearchParams({
      updateMask: translated.updateMask,
    });
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1beta/${normalizedName}?${searchParams.toString()}`,
          buildRequestInit(
            {
              body: JSON.stringify(translated.body),
              headers: this.buildHeaders(),
              method: 'PATCH',
            },
            undefined,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapGeminiError(response);
    }

    return (await response.json()) as GeminiCachedContent;
  }

  async deleteCache(name: string): Promise<void> {
    const normalizedName = normalizeGeminiCachedContentName(name);
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1beta/${normalizedName}`,
          buildRequestInit(
            {
              headers: this.buildHeaders(),
              method: 'DELETE',
            },
            undefined,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapGeminiError(response);
    }
  }

  private assertCapabilities(
    options: GeminiCompletionOptions & { stream?: boolean },
  ): void {
    if (options.tools && options.tools.length > 0) {
      this.modelRegistry.assertCapability(
        options.model,
        'supportsTools',
        'tool calling',
      );
    }

    if (options.stream) {
      this.modelRegistry.assertCapability(
        options.model,
        'supportsStreaming',
        'streaming',
      );
    }

    if (options.messages.some(messageContainsVisionContent)) {
      this.modelRegistry.assertCapability(
        options.model,
        'supportsVision',
        'vision',
      );
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    };
  }
}

export function translateGeminiRequest(
  options: GeminiCompletionOptions,
): Record<string, unknown> {
  const systemMessages = options.messages.filter(
    (message) => message.role === 'system',
  );
  const nonSystemMessages = options.messages.filter(
    (message) => message.role !== 'system',
  );
  const googleOptions = options.providerOptions?.google;
  const cachedContent = googleOptions?.promptCaching?.cachedContent;

  const body: Record<string, unknown> = {
    contents: translateGeminiMessages(nonSystemMessages, options.model),
  };

  const systemInstruction = translateGeminiSystemInstruction(
    systemMessages,
    options.system,
  );
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  const generationConfig: Record<string, unknown> = {};
  const usesResponseFormatEnvelope =
    options.responseFormat !== undefined &&
    options.responseFormat.type !== 'text' &&
    usesGeminiResponseFormatEnvelope(options.model);
  // Gemini 3.5 generateContent currently accepts responseFormat envelopes but
  // can ignore the schema when maxOutputTokens is present.
  if (options.maxTokens !== undefined && !usesResponseFormatEnvelope) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  if (
    options.temperature !== undefined &&
    supportsGeminiSamplingParameters(options.model)
  ) {
    generationConfig.temperature = options.temperature;
  }
  if (googleOptions?.thinking) {
    generationConfig.thinkingConfig = translateGeminiThinkingConfig(
      googleOptions.thinking,
    );
  }
  const responseFormat = buildGeminiResponseFormat(
    options.responseFormat,
    options.model,
  );
  if (responseFormat !== undefined) {
    Object.assign(generationConfig, responseFormat);
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

function supportsGeminiSamplingParameters(model: string): boolean {
  return model !== 'gemini-3.6-flash' && model !== 'gemini-3.5-flash-lite';
}

function translateGeminiThinkingConfig(
  thinking: NonNullable<NonNullable<ProviderOptions['google']>['thinking']>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (thinking.level !== undefined) {
    config.thinkingLevel = thinking.level;
  }
  if (thinking.budgetTokens !== undefined) {
    config.thinkingBudget = thinking.budgetTokens;
  }
  if (thinking.includeThoughts !== undefined) {
    config.includeThoughts = thinking.includeThoughts;
  }
  return config;
}

export function translateGeminiEmbeddingRequest(
  options: Pick<
    GeminiEmbeddingOptions,
    'dimensions' | 'model' | 'providerOptions' | 'purpose'
  >,
  input: EmbeddingInputItem,
): Record<string, unknown> {
  validateEmbeddingRequest(
    { ...options, input },
    {
      model: normalizeGeminiModelId(options.model),
      provider: 'google',
    },
  );
  const body: Record<string, unknown> = {
    content: translateGeminiEmbeddingContent(
      input,
      options.providerOptions?.google,
    ),
  };

  const taskType = mapEmbeddingPurposeToGeminiTaskType(options.purpose);
  if (taskType) {
    body.taskType = taskType;
  }

  if (options.dimensions !== undefined) {
    body.outputDimensionality = options.dimensions;
  }

  const title = options.providerOptions?.google?.title;
  if (title && taskType === 'RETRIEVAL_DOCUMENT') {
    body.title = title;
  }

  return body;
}

export function translateGeminiCacheCreateRequest(
  options: GeminiCreateCacheOptions,
): Record<string, unknown> {
  const messages = options.messages ?? [];
  const systemMessages = messages.filter(
    (message) => message.role === 'system',
  );
  const nonSystemMessages = messages.filter(
    (message) => message.role !== 'system',
  );
  const body: Record<string, unknown> = {
    model: normalizeGeminiCacheModelName(options.model),
  };

  if (nonSystemMessages.length > 0) {
    body.contents = nonSystemMessages.map((message) =>
      translateGeminiMessage(message),
    );
  }

  const systemInstruction = translateGeminiSystemInstruction(
    systemMessages,
    options.system,
  );
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

export function translateGeminiCacheUpdateRequest(
  options: GeminiUpdateCacheOptions,
): { body: Record<string, string>; updateMask: 'expireTime' | 'ttl' } {
  if (options.ttl && options.expireTime) {
    throw new ProviderError(
      'Gemini cache updates accept either ttl or expireTime, not both.',
      {
        provider: 'google',
      },
    );
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

export function translateGeminiTools(
  tools: CanonicalTool[],
): GeminiToolDefinition {
  return {
    functionDeclarations: validateAndCloneTools(tools, 'google').map(
      translateGeminiToolDefinition,
    ),
  };
}

export function translateGeminiTool(
  tool: CanonicalTool,
): GeminiFunctionDeclaration {
  return translateGeminiToolDefinition(validateAndCloneTool(tool, 'google'));
}

function translateGeminiToolDefinition(
  tool: CanonicalTool,
): GeminiFunctionDeclaration {
  return {
    description: tool.description,
    name: tool.name,
    parameters: translateGeminiSchema(tool.parameters),
  };
}

export function translateGeminiToolChoice(
  toolChoice: CanonicalToolChoice,
): GeminiToolConfig {
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
      mode: toolChoice.type.toUpperCase() as GeminiToolConfig['functionCallingConfig']['mode'],
    },
  };
}

export function translateGeminiResponse(
  payload: GeminiGenerateContentResponse,
  requestedModel: string,
  modelRegistry: ModelRegistry = new ModelRegistry(),
): CanonicalResponse {
  const model = modelRegistry.get(requestedModel);
  const usage = usageWithCost(
    model,
    geminiUsageToCanonical(payload.usageMetadata),
  );
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

    throw invalidProviderResponse(
      {
        model: requestedModel,
        operation: 'complete',
        provider: 'google',
      },
      {
        expected: 'non_empty_candidates_or_block_reason',
        path: 'candidates',
        phase: 'schema',
      },
    );
  }

  const parts = candidate.content?.parts ?? [];
  const finishReason = normalizeGeminiFinishReason(
    candidate.finishReason ?? null,
    parts,
  );
  if (
    !hasObservableGeminiCandidateOutput(parts) &&
    finishReason !== 'content_filter'
  ) {
    throw invalidProviderResponse(
      {
        model: requestedModel,
        operation: 'complete',
        provider: 'google',
      },
      {
        expected: 'visible_text_or_function_call',
        path: 'candidates[0].content.parts',
        phase: 'schema',
      },
    );
  }

  const content: CanonicalPart[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  let text = '';

  for (const [partIndex, part] of parts.entries()) {
    if ('text' in part) {
      if (part.thought === true) {
        continue;
      }
      content.push({
        text: part.text,
        type: 'text',
      });
      text += part.text;
      continue;
    }

    if ('functionCall' in part) {
      const id = buildGeminiToolCallId(
        candidate.index,
        partIndex,
        part.functionCall.name,
      );
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

  const response: CanonicalResponse = {
    content,
    finishReason,
    model: requestedModel,
    provider: 'google',
    raw: payload,
    text,
    toolCalls,
    usage,
  };
  if (toolCalls.length > 0 && parts.some(hasGeminiThoughtSignature)) {
    attachGoogleReplayState(response, {
      calls: parts.flatMap((part, partIndex) => {
        if (!('functionCall' in part)) {
          return [];
        }
        const canonicalId = buildGeminiToolCallId(
          candidate.index,
          partIndex,
          part.functionCall.name,
        );
        return [
          {
            args: part.functionCall.args,
            canonicalId,
            name: part.functionCall.name,
            ...(part.functionCall.id !== undefined
              ? { nativeId: part.functionCall.id }
              : {}),
            partIndex,
          },
        ];
      }),
      model: requestedModel,
      parts: cloneGeminiParts(parts),
      provider: 'google',
      version: 1,
    });
  }
  return response;
}

export function translateGeminiEmbeddingResponse(
  payload: GeminiEmbedContentResponse,
  requestedModel: string,
  modelRegistry: ModelRegistry = new ModelRegistry(),
): EmbeddingResponse {
  modelRegistry.get(requestedModel);
  const rawEmbeddings =
    payload.embeddings ?? (payload.embedding ? [payload.embedding] : []);

  if (rawEmbeddings.length === 0) {
    throw new ProviderError(
      'Gemini embedding response contained no embedding values.',
      {
        model: requestedModel,
        provider: 'google',
      },
    );
  }

  const usage = buildGeminiEmbeddingUsage(
    modelRegistry.get(requestedModel),
    payload.usageMetadata,
  );

  return {
    embeddings: rawEmbeddings.map((embedding, index) => ({
      index,
      values: embedding.values,
    })),
    model: requestedModel,
    provider: 'google',
    raw: payload,
    ...(usage ? { usage } : {}),
  };
}

export async function mapGeminiError(
  response: Response,
  model?: string,
): Promise<
  AuthenticationError | ContextLimitError | ProviderError | RateLimitError
> {
  const requestId =
    response.headers.get('x-goog-request-id') ??
    response.headers.get('x-request-id') ??
    response.headers.get('request-id') ??
    undefined;

  let body: GeminiErrorBody | undefined;
  try {
    body = (await response.json()) as GeminiErrorBody;
  } catch {
    body = undefined;
  }

  const rawMessage =
    body?.error?.message ?? `Gemini request failed with ${response.status}.`;
  const thoughtSignatureError = /thought[_ ]signature/i.test(rawMessage);
  const message = thoughtSignatureError
    ? rawMessage.replace(/[A-Za-z0-9+/=]{24,}/g, '[REDACTED]')
    : rawMessage;
  const status = body?.error?.status;
  const details = body?.error?.details;
  const baseOptions = buildGeminiErrorOptions(
    response.status,
    model,
    requestId,
    thoughtSignatureError ? undefined : details,
    response.status === 429 || response.status >= 500,
  );

  if (
    response.status === 401 ||
    response.status === 403 ||
    status === 'UNAUTHENTICATED' ||
    status === 'PERMISSION_DENIED'
  ) {
    return new AuthenticationError(message, baseOptions);
  }

  if (response.status === 429 || status === 'RESOURCE_EXHAUSTED') {
    return new RateLimitError(message, baseOptions);
  }

  if (response.status === 400 && isGeminiContextLimitMessage(message)) {
    return new ContextLimitError(message, {
      ...baseOptions,
      retryable: false,
    });
  }

  return new ProviderError(message, baseOptions);
}

class GeminiStreamAssembler {
  private readonly context: ReturnType<typeof geminiResponseContext>;
  private emittedToolCalls = new Set<string>();
  private finishReason: CanonicalFinishReason = 'stop';
  private readonly includeThoughts: boolean;
  private readonly model: string;
  private readonly modelRegistry: ModelRegistry;
  private reasoningOpen = false;
  private outputObserved = false;
  private readonly replayCalls = new Map<
    string,
    {
      args: JsonObject;
      canonicalId: string;
      name: string;
      nativeId?: string;
      partIndex: number;
    }
  >();
  private readonly replayParts: GeminiPart[] = [];
  private terminal = false;
  private usage: GeminiUsageMetadata | undefined;

  constructor(
    model: string,
    modelRegistry: ModelRegistry,
    includeThoughts: boolean,
    context: ReturnType<typeof geminiResponseContext>,
  ) {
    this.model = model;
    this.modelRegistry = modelRegistry;
    this.includeThoughts = includeThoughts;
    this.context = context;
  }

  *consume(chunk: GeminiGenerateContentResponse): Generator<StreamChunk> {
    if (chunk.usageMetadata) {
      this.usage = chunk.usageMetadata;
    }

    const candidate = chunk.candidates?.[0];
    if (!candidate) {
      if (chunk.promptFeedback?.blockReason) {
        this.finishReason = 'content_filter';
        this.terminal = true;
      }
      return;
    }

    const parts = candidate.content?.parts ?? [];
    for (const [partIndex, part] of parts.entries()) {
      if ('text' in part) {
        this.replayParts.push(cloneGeminiPart(part));
        if (part.thought === true) {
          if (this.includeThoughts && part.text.length > 0) {
            this.outputObserved = true;
            if (!this.reasoningOpen) {
              this.reasoningOpen = true;
              yield { type: 'reasoning-start' };
            }
            yield { delta: part.text, type: 'reasoning-delta' };
          }
          continue;
        }
        yield* this.closeReasoning();
        if (part.text.length > 0) {
          this.outputObserved = true;
          yield {
            delta: part.text,
            type: 'text-delta',
          };
        }
        continue;
      }

      if ('functionCall' in part) {
        yield* this.closeReasoning();
        if (part.functionCall.name.length > 0) {
          this.outputObserved = true;
        }
        const id = buildGeminiToolCallId(
          candidate.index,
          partIndex,
          part.functionCall.name,
        );
        const existingReplayCall = this.replayCalls.get(id);
        if (existingReplayCall) {
          this.replayParts[existingReplayCall.partIndex] = mergeGeminiPart(
            this.replayParts[existingReplayCall.partIndex]!,
            part,
          );
        } else {
          const replayPartIndex = this.replayParts.length;
          this.replayParts.push(cloneGeminiPart(part));
          this.replayCalls.set(id, {
            args: part.functionCall.args,
            canonicalId: id,
            name: part.functionCall.name,
            ...(part.functionCall.id !== undefined
              ? { nativeId: part.functionCall.id }
              : {}),
            partIndex: replayPartIndex,
          });
        }
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
          args: part.functionCall.args,
          id,
          name: part.functionCall.name,
          type: 'tool-call-arguments',
        };
      }
    }

    if (
      candidate.finishReason !== undefined &&
      candidate.finishReason !== null
    ) {
      this.finishReason =
        candidate.finishReason === 'STOP' && this.replayCalls.size > 0
          ? 'tool_call'
          : normalizeGeminiFinishReason(candidate.finishReason, parts);
      this.terminal = true;
    }
  }

  *finish(): Generator<StreamChunk> {
    yield* this.closeReasoning();
    if (!this.terminal) {
      throw invalidProviderResponse(this.context, {
        expected: 'candidate.finishReason_or_promptFeedback.blockReason',
        phase: 'stream',
      });
    }
    if (!this.outputObserved && this.finishReason !== 'content_filter') {
      throw invalidProviderResponse(this.context, {
        expected: 'non_empty_candidate_content',
        path: 'candidates[0].content.parts',
        phase: 'stream',
      });
    }
    const model = this.modelRegistry.get(this.model);
    const done: StreamChunk = {
      finishReason: this.finishReason,
      type: 'done',
      usage: usageWithCost(model, geminiUsageToCanonical(this.usage)),
    };
    if (
      this.replayCalls.size > 0 &&
      this.replayParts.some(hasGeminiThoughtSignature)
    ) {
      attachGoogleReplayState(done, {
        calls: [...this.replayCalls.values()],
        model: this.model,
        parts: cloneGeminiParts(this.replayParts),
        provider: 'google',
        version: 1,
      });
    }
    yield done;
  }

  private *closeReasoning(): Generator<StreamChunk> {
    if (!this.reasoningOpen) {
      return;
    }
    this.reasoningOpen = false;
    yield { type: 'reasoning-end' };
  }
}

function geminiResponseContext(
  response: Response,
  options: { model?: string; signal?: AbortSignal },
  operation: string,
) {
  return {
    ...(options.model ? { model: options.model } : {}),
    operation,
    provider: 'google' as const,
    requestId:
      response.headers.get('x-goog-request-id') ??
      response.headers.get('x-request-id') ??
      undefined,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function validateGeminiResponsePayload(
  value: unknown,
  context: ReturnType<typeof geminiResponseContext>,
  stream = false,
): asserts value is GeminiGenerateContentResponse {
  assertProviderObject(value, context, 'response');
  if (value.candidates !== undefined) {
    assertProviderArray(value.candidates, context, 'candidates');
    for (const [index, candidate] of value.candidates.entries()) {
      assertProviderObject(candidate, context, `candidates[${index}]`);
      assertNonNegativeProviderInteger(
        candidate.index,
        context,
        `candidates[${index}].index`,
      );
      if (
        candidate.finishReason !== undefined &&
        candidate.finishReason !== null
      ) {
        assertProviderString(
          candidate.finishReason,
          context,
          `candidates[${index}].finishReason`,
        );
      }
      if (candidate.content !== undefined) {
        assertProviderObject(
          candidate.content,
          context,
          `candidates[${index}].content`,
        );
        assertProviderArray(
          candidate.content.parts,
          context,
          `candidates[${index}].content.parts`,
        );
        for (const [partIndex, part] of candidate.content.parts.entries()) {
          assertProviderObject(
            part,
            context,
            `candidates[${index}].content.parts[${partIndex}]`,
          );
          if (part.text !== undefined) {
            assertProviderString(
              part.text,
              context,
              `candidates[${index}].content.parts[${partIndex}].text`,
            );
          }
          if (part.thought !== undefined && typeof part.thought !== 'boolean') {
            throw invalidProviderResponse(context, {
              expected: 'boolean',
              path: `candidates[${index}].content.parts[${partIndex}].thought`,
              phase: 'schema',
            });
          }
          if (part.thoughtSignature !== undefined) {
            assertProviderString(
              part.thoughtSignature,
              context,
              `candidates[${index}].content.parts[${partIndex}].thoughtSignature`,
            );
          }
          if (part.thought_signature !== undefined) {
            assertProviderString(
              part.thought_signature,
              context,
              `candidates[${index}].content.parts[${partIndex}].thought_signature`,
            );
          }
          if (part.functionCall !== undefined) {
            assertProviderObject(
              part.functionCall,
              context,
              `candidates[${index}].content.parts[${partIndex}].functionCall`,
            );
            if (part.functionCall.id !== undefined) {
              assertProviderString(
                part.functionCall.id,
                context,
                `candidates[${index}].content.parts[${partIndex}].functionCall.id`,
              );
            }
            assertProviderString(
              part.functionCall.name,
              context,
              `candidates[${index}].content.parts[${partIndex}].functionCall.name`,
            );
            assertProviderObject(
              part.functionCall.args,
              context,
              `candidates[${index}].content.parts[${partIndex}].functionCall.args`,
            );
          }
        }
      }
    }
  }
  assertProviderUsage(
    value.usageMetadata,
    [
      'cachedContentTokenCount',
      'candidatesTokenCount',
      'promptTokenCount',
      'thoughtsTokenCount',
      'totalTokenCount',
    ],
    context,
    'usageMetadata',
  );
  if (
    !stream &&
    (!Array.isArray(value.candidates) || value.candidates.length === 0) &&
    !(
      isPlainObject(value.promptFeedback) &&
      typeof value.promptFeedback.blockReason === 'string' &&
      value.promptFeedback.blockReason.length > 0
    )
  ) {
    throw invalidProviderResponse(context, {
      expected: 'non_empty_candidates_or_block_reason',
      path: 'candidates',
      phase: 'schema',
    });
  }
  if (
    !stream &&
    Array.isArray(value.candidates) &&
    value.candidates.length > 0
  ) {
    const candidate = value.candidates[0];
    const parts =
      isPlainObject(candidate) &&
      isPlainObject(candidate.content) &&
      Array.isArray(candidate.content.parts)
        ? candidate.content.parts
        : [];
    const finishReason =
      isPlainObject(candidate) && typeof candidate.finishReason === 'string'
        ? normalizeGeminiFinishReason(
            candidate.finishReason as GeminiFinishReason,
            [],
          )
        : undefined;
    if (
      !hasObservableGeminiCandidateOutput(parts as GeminiPart[]) &&
      finishReason !== 'content_filter'
    ) {
      throw invalidProviderResponse(context, {
        expected: 'visible_text_or_function_call',
        path: 'candidates[0].content.parts',
        phase: 'schema',
      });
    }
  }
}

function hasObservableGeminiCandidateOutput(
  parts: readonly GeminiPart[],
): boolean {
  return parts.some(
    (part) =>
      ('text' in part && part.thought !== true && part.text.length > 0) ||
      ('functionCall' in part && part.functionCall.name.length > 0),
  );
}

function validateGeminiEmbeddingPayload(
  value: unknown,
  context: ReturnType<typeof geminiResponseContext>,
): asserts value is GeminiEmbedContentResponse {
  assertProviderObject(value, context, 'response');
  const embeddings =
    value.embeddings ??
    (value.embedding === undefined ? undefined : [value.embedding]);
  assertProviderArray(embeddings, context, 'embeddings');
  if (embeddings.length === 0) {
    throw invalidProviderResponse(context, {
      expected: 'non_empty_array',
      path: 'embeddings',
      phase: 'schema',
    });
  }
  for (const [index, embedding] of embeddings.entries()) {
    assertProviderObject(embedding, context, `embeddings[${index}]`);
    assertProviderArray(
      embedding.values,
      context,
      `embeddings[${index}].values`,
    );
    if (embedding.values.length === 0) {
      throw invalidProviderResponse(context, {
        expected: 'non_empty_finite_number_array',
        path: `embeddings[${index}].values`,
        phase: 'schema',
      });
    }
    if (
      embedding.values.some(
        (item) => typeof item !== 'number' || !Number.isFinite(item),
      )
    ) {
      throw invalidProviderResponse(context, {
        expected: 'finite_number_array',
        path: `embeddings[${index}].values`,
        phase: 'schema',
      });
    }
  }
  assertProviderUsage(
    value.usageMetadata,
    ['promptTokenCount', 'totalTokenCount'],
    context,
    'usageMetadata',
  );
}

function assertNonNegativeProviderInteger(
  value: unknown,
  context: ReturnType<typeof geminiResponseContext>,
  path: string,
): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidProviderResponse(context, {
      expected: 'non_negative_safe_integer',
      path,
      phase: 'schema',
    });
  }
}

function translateGeminiMessages(
  messages: CanonicalMessage[],
  model: string,
): GeminiContent[] {
  const nativeIds = new Map<string, string>();
  return messages.map((message) => {
    const state = getGoogleReplayStateForMessage(message, model);
    if (state) {
      for (const call of state.calls) {
        if (call.nativeId !== undefined) {
          nativeIds.set(call.canonicalId, call.nativeId);
        }
      }
      return {
        parts: state.parts as unknown as GeminiPart[],
        role: 'model',
      };
    }
    return translateGeminiMessage(message, nativeIds);
  });
}

function translateGeminiMessage(
  message: CanonicalMessage,
  nativeIds: ReadonlyMap<string, string> = new Map(),
): GeminiContent {
  if (message.role === 'system') {
    throw new ProviderCapabilityError(
      'System messages must be lifted into Gemini systemInstruction.',
      {
        provider: 'google',
      },
    );
  }

  const role: GeminiRole = message.role === 'assistant' ? 'model' : 'user';

  return {
    parts:
      typeof message.content === 'string'
        ? [{ text: message.content }]
        : message.content.map((part) =>
            translateGeminiPart(
              message.role === 'assistant' ? 'assistant' : 'user',
              part,
              nativeIds,
            ),
          ),
    role,
  };
}

function translateGeminiEmbeddingContent(
  input: EmbeddingInputItem,
  options: EmbeddingProviderOptions['google'] | undefined,
): GeminiContent {
  const parts: GeminiPart[] = [];
  if (options?.taskInstruction) {
    parts.push({ text: options.taskInstruction });
  }

  if (typeof input === 'string') {
    parts.push({ text: input });
    return { parts };
  }

  for (const part of input) {
    parts.push(translateGeminiEmbeddingPart(part));
  }

  return { parts };
}

function translateGeminiPart(
  role: Exclude<CanonicalMessage['role'], 'system'>,
  part: CanonicalPart,
  nativeIds: ReadonlyMap<string, string> = new Map(),
): GeminiPart {
  switch (part.type) {
    case 'audio':
      return translateGeminiBinaryLikePart(
        part.data,
        part.mediaType,
        part.url,
        'Gemini audio parts require data or a URL.',
      );
    case 'document':
      return translateGeminiBinaryLikePart(
        part.data,
        part.mediaType,
        part.url,
        'Gemini documents require data or a URL.',
      );
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
          mimeType:
            part.mediaType ?? inferMediaTypeFromUrl(part.url) ?? 'image/*',
        },
      };
    case 'text':
      return {
        text: part.text,
      };
    case 'tool_call':
      if (role !== 'assistant') {
        throw new ProviderCapabilityError(
          'Gemini tool calls must appear in assistant messages.',
          {
            provider: 'google',
          },
        );
      }

      return {
        functionCall: {
          args: part.args,
          name: part.name,
        },
      };
    case 'tool_result':
      if (role !== 'user') {
        throw new ProviderCapabilityError(
          'Gemini tool results must appear in user messages.',
          {
            provider: 'google',
          },
        );
      }

      return {
        functionResponse: {
          ...(nativeIds.get(part.toolCallId) !== undefined
            ? { id: nativeIds.get(part.toolCallId)! }
            : {}),
          name: part.name ?? part.toolCallId,
          response: normalizeGeminiToolResult(part.result, part.isError),
        },
      };
  }
}

function isGeminiContextLimitMessage(message: string): boolean {
  return /(?:context\s+(?:window|length)|maximum\s+(?:input\s+)?tokens?|max(?:imum)?\s+token\s+(?:count|limit)|token count exceeds .*maximum number of tokens allowed|token\s+(?:count|limit)\s+(?:is\s+)?(?:exceeded|over)|exceeds?\s+(?:the\s+)?(?:context|token))/i.test(
    message,
  );
}

function cloneGeminiParts(parts: readonly GeminiPart[]): JsonObject[] {
  return JSON.parse(JSON.stringify(parts)) as JsonObject[];
}

function hasGeminiThoughtSignature(part: GeminiPart): boolean {
  return 'thoughtSignature' in part || 'thought_signature' in part;
}

function cloneGeminiPart(part: GeminiPart): GeminiPart {
  return JSON.parse(JSON.stringify(part)) as GeminiPart;
}

function mergeGeminiPart(current: GeminiPart, next: GeminiPart): GeminiPart {
  if ('functionCall' in current && 'functionCall' in next) {
    return {
      ...current,
      ...next,
      functionCall: {
        ...current.functionCall,
        ...next.functionCall,
      },
    };
  }
  return cloneGeminiPart(next);
}

function translateGeminiEmbeddingPart(part: CanonicalPart): GeminiPart {
  switch (part.type) {
    case 'audio':
      return translateGeminiBinaryLikePart(
        part.data,
        part.mediaType,
        part.url,
        'Gemini embedding audio parts require data or a URL.',
      );
    case 'document':
      return translateGeminiBinaryLikePart(
        part.data,
        part.mediaType,
        part.url,
        'Gemini embedding documents require data or a URL.',
      );
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
          mimeType:
            part.mediaType ?? inferMediaTypeFromUrl(part.url) ?? 'image/*',
        },
      };
    case 'text':
      return {
        text: part.text,
      };
    case 'tool_call':
    case 'tool_result':
      throw new ProviderCapabilityError(
        'Gemini embeddings do not support tool call or tool result parts.',
        {
          provider: 'google',
        },
      );
  }
}

function translateGeminiSystemInstruction(
  systemMessages: CanonicalMessage[],
  explicitSystem: string | undefined,
): GeminiContent | undefined {
  if (!explicitSystem && systemMessages.length === 0) {
    return undefined;
  }

  const parts: GeminiTextPart[] = [];
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
        throw new ProviderCapabilityError(
          'Gemini system instructions currently support text content only.',
          {
            provider: 'google',
          },
        );
      }

      parts.push({ text: part.text });
    }
  }

  return { parts };
}

function applyGeminiCacheExpiration(
  body: Record<string, unknown>,
  ttl: string | undefined,
  expireTime: string | undefined,
): void {
  if (ttl && expireTime) {
    throw new ProviderError(
      'Gemini cache requests accept either ttl or expireTime, not both.',
      {
        provider: 'google',
      },
    );
  }

  if (ttl) {
    body.ttl = ttl;
  }

  if (expireTime) {
    body.expireTime = expireTime;
  }
}

function normalizeGeminiCacheModelName(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

function normalizeGeminiModelId(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

// Gemini cache resource IDs are opaque tokens; the API returns names shaped as
// `cachedContents/<id>`. Only accept that exact grammar so a caller-supplied
// name cannot inject path separators, `..`, or query characters into the
// authenticated request URL.
const GEMINI_CACHE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function normalizeGeminiCachedContentName(name: string): string {
  const id = name.startsWith('cachedContents/')
    ? name.slice('cachedContents/'.length)
    : name;
  if (!GEMINI_CACHE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid Gemini cache name "${name}". Expected "cachedContents/<id>" where id matches ${String(
        GEMINI_CACHE_ID_PATTERN,
      )}.`,
    );
  }
  return `cachedContents/${encodeURIComponent(id)}`;
}

function translateGeminiSchema(schema: CanonicalToolSchema): GeminiToolSchema {
  const translated: GeminiToolSchema = {
    type: schema.type.toUpperCase() as GeminiToolSchema['type'],
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

  if (schema.items !== undefined) {
    translated.items = translateGeminiSchema(schema.items);
  }

  if (schema.properties !== undefined) {
    translated.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        translateGeminiSchema(value),
      ]),
    );
  }

  return translated;
}

function normalizeGeminiFinishReason(
  finishReason: GeminiFinishReason,
  parts: GeminiPart[],
): CanonicalFinishReason {
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
      return parts.some((part) => 'functionCall' in part)
        ? 'tool_call'
        : 'stop';
    case 'LANGUAGE':
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
      return 'error';
    case null:
      return 'stop';
  }
}

function mapEmbeddingPurposeToGeminiTaskType(
  purpose: EmbeddingPurpose | undefined,
):
  | 'CLASSIFICATION'
  | 'CLUSTERING'
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'
  | undefined {
  switch (purpose) {
    case 'classification':
      return 'CLASSIFICATION';
    case 'clustering':
      return 'CLUSTERING';
    case 'retrieval_document':
      return 'RETRIEVAL_DOCUMENT';
    case 'retrieval_query':
      return 'RETRIEVAL_QUERY';
    case 'semantic_similarity':
      return 'SEMANTIC_SIMILARITY';
    case undefined:
      return undefined;
  }
}

function buildGeminiEmbeddingUsage(
  model: ReturnType<ModelRegistry['get']>,
  usage: GeminiUsageMetadata | undefined,
): EmbeddingUsageMetrics | undefined {
  if (usage?.promptTokenCount === undefined) {
    return undefined;
  }

  const metrics: EmbeddingUsageMetrics = {
    inputTokens: usage.promptTokenCount,
  };

  if (model.inputPrice > 0) {
    const costUSD = roundEmbeddingUsd(
      (usage.promptTokenCount / 1_000_000) * model.inputPrice,
    );
    metrics.costUSD = costUSD;
    metrics.cost = formatEmbeddingCost(costUSD);
  }

  return metrics;
}

function formatEmbeddingCost(usd: number): string {
  if (usd === 0) {
    return '$0.00';
  }

  if (Math.abs(usd) < 0.01) {
    return `$${usd.toFixed(4)}`;
  }

  return `$${usd.toFixed(2)}`;
}

function roundEmbeddingUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function messageContainsVisionContent(message: CanonicalMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some(
      (part) => part.type === 'image_base64' || part.type === 'image_url',
    )
  );
}

function translateGeminiBinaryLikePart(
  data: string | undefined,
  mediaType: string,
  url: string | undefined,
  missingMessage: string,
): GeminiFileDataPart | GeminiInlineDataPart {
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

function normalizeGeminiToolResult(
  result: JsonValue,
  isError: boolean | undefined,
): JsonObject {
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

function isPlainJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inferMediaTypeFromUrl(url: string): string | null {
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

function buildGeminiToolCallId(
  candidateIndex: number,
  partIndex: number,
  toolName: string,
): string {
  return `gemini_tool_${candidateIndex}_${partIndex}_${toolName}`;
}

function buildGeminiErrorOptions(
  statusCode: number,
  model: string | undefined,
  requestId: string | undefined,
  details: GeminiErrorDetail[] | undefined,
  retryable: boolean,
): {
  details?: Record<string, unknown>;
  model?: string;
  provider: 'google';
  requestId?: string;
  retryable: boolean;
  statusCode: number;
} {
  return {
    ...(details ? { details: { errorDetails: details } } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    provider: 'google',
    retryable,
    statusCode,
  };
}

function buildRequestInit(
  init: Omit<RequestInit, 'signal'>,
  signal: AbortSignal | undefined,
): RequestInit {
  if (!signal) {
    return init;
  }

  return {
    ...init,
    signal,
  };
}
