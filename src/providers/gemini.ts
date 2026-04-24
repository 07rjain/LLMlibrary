import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import { geminiUsageToCanonical, usageWithCost } from '../utils/cost.js';
import { parseSSE } from '../utils/parse-sse.js';
import { withRetry } from '../utils/retry.js';

import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalPart,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
  CanonicalToolSchema,
  EmbeddingInput,
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
    name: string;
  };
}

interface GeminiFunctionResponsePart {
  functionResponse: {
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

interface GeminiModelPayload {
  description?: string;
  displayName?: string;
  inputTokenLimit?: number;
  name: string;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiModelListPayload {
  models?: GeminiModelPayload[];
  nextPageToken?: string;
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
  signal?: AbortSignal;
  system?: string;
  temperature?: number;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

export interface GeminiEmbeddingOptions
  extends Pick<
    EmbeddingRequestOptions,
    'botId' | 'dimensions' | 'input' | 'providerOptions' | 'purpose' | 'signal' | 'tenantId'
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
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
    this.retryOptions = config.retryOptions;
  }

  async complete(options: GeminiCompletionOptions): Promise<CanonicalResponse> {
    this.assertCapabilities(options);

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
    );

    if (!response.ok) {
      throw await mapGeminiError(response, options.model);
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    return translateGeminiResponse(payload, options.model, this.modelRegistry);
  }

  async embed(options: GeminiEmbeddingOptions): Promise<EmbeddingResponse> {
    const requests = normalizeGeminiEmbeddingInput(options.input);
    if (requests.length === 0) {
      throw new ProviderError('Gemini embedding requests require at least one input item.', {
        model: options.model,
        provider: 'google',
      });
    }

    const embeddings: EmbeddingResponse['embeddings'] = [];
    let lastPayload: GeminiEmbedContentResponse | undefined;
    let totalPromptTokens = 0;
    let observedPromptTokens = false;

    for (const [index, input] of requests.entries()) {
      const response = await withRetry(
        async () =>
          this.fetchImplementation(
            `${this.baseUrl}/v1beta/models/${encodeURIComponent(normalizeGeminiModelId(options.model))}:embedContent`,
            buildRequestInit(
              {
                body: JSON.stringify(translateGeminiEmbeddingRequest(options, input)),
                headers: this.buildHeaders(),
                method: 'POST',
              },
              options.signal,
            ),
          ),
        this.retryOptions,
      );

      if (!response.ok) {
        throw await mapGeminiError(response, options.model);
      }

      const payload = (await response.json()) as GeminiEmbedContentResponse;
      const translated = translateGeminiEmbeddingResponse(payload, options.model, this.modelRegistry);
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
      throw new ProviderError('Gemini embedding response contained no embedding values.', {
        model: options.model,
        provider: 'google',
      });
    }

    const usage = buildGeminiEmbeddingUsage(
      this.modelRegistry.get(options.model),
      observedPromptTokens ? { promptTokenCount: totalPromptTokens } : undefined,
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
    );

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
      const chunk = JSON.parse(payload) as GeminiGenerateContentResponse;
      yield* assembler.consume(chunk);
    }

    yield assembler.finish();
  }

  async createCache(options: GeminiCreateCacheOptions): Promise<GeminiCachedContent> {
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

      const payload = (await response.json()) as GeminiModelListPayload;
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
      this.modelRegistry.assertCapability(options.model, 'supportsTools', 'tool calling');
    }

    if (options.stream) {
      this.modelRegistry.assertCapability(options.model, 'supportsStreaming', 'streaming');
    }

    if (options.messages.some(messageContainsVisionContent)) {
      this.modelRegistry.assertCapability(options.model, 'supportsVision', 'vision');
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
  const systemMessages = options.messages.filter((message) => message.role === 'system');
  const nonSystemMessages = options.messages.filter((message) => message.role !== 'system');
  const cachedContent = options.providerOptions?.google?.promptCaching?.cachedContent;

  const body: Record<string, unknown> = {
    contents: nonSystemMessages.map(translateGeminiMessage),
  };

  const systemInstruction = translateGeminiSystemInstruction(
    systemMessages,
    options.system,
  );
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  const generationConfig: Record<string, unknown> = {};
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

export function translateGeminiEmbeddingRequest(
  options: Pick<
    GeminiEmbeddingOptions,
    'dimensions' | 'model' | 'providerOptions' | 'purpose'
  >,
  input: EmbeddingInputItem,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: translateGeminiEmbeddingContent(input, options.providerOptions?.google),
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
  const systemMessages = messages.filter((message) => message.role === 'system');
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');
  const body: Record<string, unknown> = {
    model: normalizeGeminiCacheModelName(options.model),
  };

  if (nonSystemMessages.length > 0) {
    body.contents = nonSystemMessages.map(translateGeminiMessage);
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

  throw new ProviderError(
    'Gemini cache updates require ttl or expireTime.',
    {
      provider: 'google',
    },
  );
}

export function translateGeminiTools(
  tools: CanonicalTool[],
): GeminiToolDefinition {
  return {
    functionDeclarations: tools.map(translateGeminiTool),
  };
}

export function translateGeminiTool(
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

  const content: CanonicalPart[] = [];
  const toolCalls: CanonicalToolCall[] = [];
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
    finishReason: normalizeGeminiFinishReason(
      candidate.finishReason ?? null,
      candidate.content?.parts ?? [],
    ),
    model: requestedModel,
    provider: 'google',
    raw: payload,
    text,
    toolCalls,
    usage,
  };
}

export function translateGeminiEmbeddingResponse(
  payload: GeminiEmbedContentResponse,
  requestedModel: string,
  modelRegistry: ModelRegistry = new ModelRegistry(),
): EmbeddingResponse {
  modelRegistry.get(requestedModel);
  const rawEmbeddings =
    payload.embeddings ??
    (payload.embedding ? [payload.embedding] : []);

  if (rawEmbeddings.length === 0) {
    throw new ProviderError('Gemini embedding response contained no embedding values.', {
      model: requestedModel,
      provider: 'google',
    });
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
): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError> {
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

  const message = body?.error?.message ?? `Gemini request failed with ${response.status}.`;
  const status = body?.error?.status;
  const details = body?.error?.details;
  const baseOptions = buildGeminiErrorOptions(
    response.status,
    model,
    requestId,
    details,
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

  if (
    response.status === 400 &&
    (status === 'INVALID_ARGUMENT' || /context|token/i.test(message))
  ) {
    return new ContextLimitError(message, {
      ...baseOptions,
      retryable: false,
    });
  }

  return new ProviderError(message, baseOptions);
}

class GeminiStreamAssembler {
  private emittedToolCalls = new Set<string>();
  private finishReason: CanonicalFinishReason = 'stop';
  private readonly model: string;
  private readonly modelRegistry: ModelRegistry;
  private usage: GeminiUsageMetadata | undefined;

  constructor(model: string, modelRegistry: ModelRegistry) {
    this.model = model;
    this.modelRegistry = modelRegistry;
  }

  *consume(chunk: GeminiGenerateContentResponse): Generator<StreamChunk> {
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

  finish(): StreamChunk {
    const model = this.modelRegistry.get(this.model);
    return {
      finishReason: this.finishReason,
      type: 'done',
      usage: usageWithCost(model, geminiUsageToCanonical(this.usage)),
    };
  }
}

function translateGeminiMessage(message: CanonicalMessage): GeminiContent {
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
            translateGeminiPart(message.role === 'assistant' ? 'assistant' : 'user', part),
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
          mimeType: part.mediaType ?? inferMediaTypeFromUrl(part.url) ?? 'image/*',
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
          name: part.name ?? part.toolCallId,
          response: normalizeGeminiToolResult(part.result, part.isError),
        },
      };
  }
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
          mimeType: part.mediaType ?? inferMediaTypeFromUrl(part.url) ?? 'image/*',
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

function normalizeGeminiCachedContentName(name: string): string {
  return name.startsWith('cachedContents/') ? name : `cachedContents/${name}`;
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

  if (schema.additionalProperties !== undefined) {
    translated.additionalProperties = schema.additionalProperties;
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
      return parts.some((part) => 'functionCall' in part) ? 'tool_call' : 'stop';
    case 'LANGUAGE':
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
      return 'error';
    case null:
      return 'stop';
  }
}

function normalizeGeminiEmbeddingInput(
  input: EmbeddingInput,
): EmbeddingInputItem[] {
  if (typeof input === 'string') {
    return [input];
  }

  if (!Array.isArray(input)) {
    return [input];
  }

  if (input.length === 0) {
    return [];
  }

  if (isCanonicalPartArray(input)) {
    return [input];
  }

  return input;
}

function isCanonicalPartArray(input: EmbeddingInput): input is CanonicalPart[] {
  return (
    Array.isArray(input) &&
    input.every(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'type' in value,
    )
  );
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
