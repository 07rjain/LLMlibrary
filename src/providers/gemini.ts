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
  JsonObject,
  JsonValue,
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
  signal?: AbortSignal;
  system?: string;
  temperature?: number;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
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

  return body;
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
