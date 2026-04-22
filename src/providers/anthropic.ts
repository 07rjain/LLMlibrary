import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import { anthropicUsageToCanonical, usageWithCost } from '../utils/cost.js';
import { parseSSE } from '../utils/parse-sse.js';
import { withRetry } from '../utils/retry.js';

import type {
  CacheControl,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalPart,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
  JsonObject,
  JsonValue,
  ProviderOptions,
  RemoteModelInfo,
  StreamChunk,
} from '../types.js';
import type { RetryOptions } from '../utils/retry.js';

type AnthropicRole = 'assistant' | 'user';

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicTextBlock {
  cache_control?: CacheControl;
  text: string;
  type: 'text';
}

interface AnthropicImageBlock {
  cache_control?: CacheControl;
  source:
    | { type: 'url'; url: string }
    | { data: string; media_type: string; type: 'base64' };
  type: 'image';
}

interface AnthropicDocumentBlock {
  cache_control?: CacheControl;
  source:
    | { type: 'url'; url: string }
    | { data: string; media_type: string; type: 'base64' };
  title?: string;
  type: 'document';
}

interface AnthropicToolUseBlock {
  cache_control?: CacheControl;
  id: string;
  input: JsonObject;
  name: string;
  type: 'tool_use';
}

interface AnthropicToolResultBlock {
  cache_control?: CacheControl;
  content: string;
  is_error?: boolean;
  tool_use_id: string;
  type: 'tool_result';
}

interface AnthropicMessage {
  content: AnthropicContentBlock[] | string;
  role: AnthropicRole;
}

interface AnthropicToolDefinition {
  cache_control?: CacheControl;
  description: string;
  input_schema: CanonicalTool['parameters'];
  name: string;
}

type AnthropicToolChoice =
  | { type: 'any' | 'auto' | 'none' }
  | { disable_parallel_tool_use?: boolean; name: string; type: 'tool' };

interface AnthropicUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponsePayload {
  content: AnthropicContentBlock[];
  id: string;
  model: string;
  role: 'assistant';
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  usage?: AnthropicUsage;
}

interface AnthropicErrorBody {
  error?: {
    message?: string;
    type?: string;
  };
  type?: 'error';
}

interface AnthropicModelPayload {
  created_at?: string;
  display_name?: string;
  id: string;
  type?: string;
}

interface AnthropicModelListPayload {
  data?: AnthropicModelPayload[];
  has_more?: boolean;
  last_id?: string;
}

interface AnthropicSSEEvent {
  content_block?: AnthropicContentBlock;
  delta?: {
    partial_json?: string;
    stop_reason?: AnthropicResponsePayload['stop_reason'];
    text?: string;
    type?: 'input_json_delta' | 'text_delta';
  };
  index?: number;
  message?: AnthropicResponsePayload & { stop_reason: null };
  type:
    | 'content_block_delta'
    | 'content_block_start'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_start'
    | 'message_stop';
  usage?: AnthropicUsage;
}

export interface AnthropicClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  modelRegistry?: ModelRegistry;
  retryOptions?: RetryOptions;
}

export interface AnthropicCompletionOptions {
  maxTokens: number;
  messages: CanonicalMessage[];
  model: string;
  providerOptions?: ProviderOptions;
  signal?: AbortSignal;
  system?: string;
  temperature?: number;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

export class AnthropicAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly modelRegistry: ModelRegistry;
  private readonly retryOptions: RetryOptions | undefined;

  constructor(config: AnthropicClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
    this.retryOptions = config.retryOptions;
  }

  async complete(options: AnthropicCompletionOptions): Promise<CanonicalResponse> {
    this.assertCapabilities(options);

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/messages`,
          buildRequestInit(
            {
              body: JSON.stringify(translateAnthropicRequest(options)),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapAnthropicError(response, options.model);
    }

    const payload = (await response.json()) as AnthropicResponsePayload;
    return translateAnthropicResponse(payload, this.modelRegistry, options.model);
  }

  async *stream(
    options: AnthropicCompletionOptions,
  ): AsyncGenerator<StreamChunk, void, void> {
    this.assertCapabilities({ ...options, stream: true });

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/messages`,
          buildRequestInit(
            {
              body: JSON.stringify({
                ...translateAnthropicRequest(options),
                stream: true,
              }),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapAnthropicError(response, options.model);
    }

    if (!response.body) {
      throw new ProviderError('Anthropic streaming response did not include a body.', {
        model: options.model,
        provider: 'anthropic',
      });
    }

    const assembler = new AnthropicStreamAssembler(
      options.model,
      this.modelRegistry,
    );

    for await (const payload of parseSSE(response.body)) {
      const event = JSON.parse(payload) as AnthropicSSEEvent;
      yield* assembler.consume(event);
    }

    const doneChunk = assembler.finish();
    if (doneChunk) {
      yield doneChunk;
    }
  }

  async listModels(): Promise<RemoteModelInfo[]> {
    const models: RemoteModelInfo[] = [];
    let afterId: string | undefined;

    while (true) {
      const searchParams = new URLSearchParams({
        limit: '100',
      });
      if (afterId) {
        searchParams.set('after_id', afterId);
      }

      const response = await withRetry(
        async () =>
          this.fetchImplementation(
            `${this.baseUrl}/v1/models?${searchParams.toString()}`,
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
        throw await mapAnthropicError(response);
      }

      const payload = (await response.json()) as AnthropicModelListPayload;
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

  private assertCapabilities(
    options: AnthropicCompletionOptions & { stream?: boolean },
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

    if (options.messages.some(messageContainsAudio)) {
      throw new ProviderCapabilityError(
        `Model "${options.model}" does not support audio input through Anthropic messages.`,
        {
          model: options.model,
          provider: 'anthropic',
        },
      );
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
    };
  }
}

export function translateAnthropicRequest(
  options: AnthropicCompletionOptions,
): Record<string, unknown> {
  const systemMessages = options.messages.filter((message) => message.role === 'system');
  const nonSystemMessages = options.messages.filter((message) => message.role !== 'system');
  const cacheControl = options.providerOptions?.anthropic?.cacheControl;

  const body: Record<string, unknown> = {
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

export function translateAnthropicTool(
  tool: CanonicalTool,
): AnthropicToolDefinition {
  return {
    ...(tool.cacheControl !== undefined ? { cache_control: tool.cacheControl } : {}),
    description: tool.description,
    input_schema: tool.parameters,
    name: tool.name,
  };
}

export function translateAnthropicToolChoice(
  toolChoice: CanonicalToolChoice,
): AnthropicToolChoice {
  if (toolChoice.type === 'tool') {
    const mappedChoice: AnthropicToolChoice = {
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

export function translateAnthropicResponse(
  payload: AnthropicResponsePayload,
  modelRegistry: ModelRegistry = new ModelRegistry(),
  requestedModel?: string,
): CanonicalResponse {
  const resolvedModelId = resolveAnthropicModelId(
    payload.model,
    requestedModel,
    modelRegistry,
  );
  const model = modelRegistry.get(resolvedModelId);
  const usage = usageWithCost(model, anthropicUsageToCanonical(payload.usage));
  const toolCalls: CanonicalToolCall[] = [];
  const content: CanonicalPart[] = [];
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

function resolveAnthropicModelId(
  responseModel: string,
  requestedModel: string | undefined,
  modelRegistry: ModelRegistry,
): string {
  if (modelRegistry.isSupported(responseModel)) {
    return responseModel;
  }

  if (
    requestedModel &&
    modelRegistry.isSupported(requestedModel) &&
    responseModel.startsWith(`${requestedModel}-`)
  ) {
    return requestedModel;
  }

  return responseModel;
}

export async function mapAnthropicError(
  response: Response,
  model?: string,
): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError> {
  const requestId =
    response.headers.get('anthropic-request-id') ?? response.headers.get('request-id') ?? undefined;
  let body: AnthropicErrorBody | undefined;

  try {
    body = (await response.json()) as AnthropicErrorBody;
  } catch {
    body = undefined;
  }

  const message = body?.error?.message ?? `Anthropic request failed with ${response.status}.`;
  const type = body?.error?.type;
  const baseOptions = buildAnthropicErrorOptions(
    response.status,
    model,
    requestId,
    response.status === 429 || response.status >= 500,
  );

  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(message, baseOptions);
  }

  if (response.status === 429) {
    return new RateLimitError(message, baseOptions);
  }

  if (
    response.status === 400 &&
    (type === 'invalid_request_error' || type === 'context_limit_error') &&
    /context|token/i.test(message)
  ) {
    return new ContextLimitError(message, {
      ...baseOptions,
      retryable: false,
    });
  }

  return new ProviderError(message, baseOptions);
}

class AnthropicStreamAssembler {
  private finishReason: CanonicalFinishReason = 'stop';
  private readonly model: string;
  private readonly modelRegistry: ModelRegistry;
  private toolBuffer = new Map<number, { id: string; json: string; name: string }>();
  private usage: AnthropicUsage = {};

  constructor(model: string, modelRegistry: ModelRegistry) {
    this.model = model;
    this.modelRegistry = modelRegistry;
  }

  *consume(event: AnthropicSSEEvent): Generator<StreamChunk> {
    switch (event.type) {
      case 'message_start':
        this.usage = event.message?.usage ?? {};
        return;
      case 'content_block_start':
        if (
          event.content_block?.type === 'tool_use' &&
          event.index !== undefined
        ) {
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

        if (
          event.delta?.type === 'input_json_delta' &&
          event.delta.partial_json &&
          event.index !== undefined
        ) {
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
        this.finishReason = normalizeAnthropicFinishReason(
          event.delta?.stop_reason ?? 'end_turn',
        );
        this.usage = {
          ...this.usage,
          ...event.usage,
        };
        return;
      case 'message_stop':
        return;
    }
  }

  finish(): StreamChunk | null {
    const modelInfo = this.modelRegistry.get(this.model);
    return {
      finishReason: this.finishReason,
      type: 'done',
      usage: usageWithCost(modelInfo, anthropicUsageToCanonical(this.usage)),
    };
  }

  private *flushToolCall(index: number): Generator<StreamChunk> {
    const tool = this.toolBuffer.get(index);
    if (!tool) {
      return;
    }

    this.toolBuffer.delete(index);
    const parsed = tool.json ? (JSON.parse(tool.json) as JsonValue) : {};
    yield {
      id: tool.id,
      name: tool.name,
      result: parsed,
      type: 'tool-call-result',
    };
  }
}

function translateAnthropicMessage(message: CanonicalMessage): AnthropicMessage {
  if (message.role === 'system') {
    throw new ProviderCapabilityError(
      'System messages must be lifted into the top-level Anthropic system field.',
      {
        provider: 'anthropic',
      },
    );
  }
  const role: AnthropicRole = message.role;

  return {
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => translateAnthropicPart(role, part)),
    role,
  };
}

function translateAnthropicPart(
  role: AnthropicRole,
  part: CanonicalPart,
): AnthropicContentBlock {
  switch (part.type) {
    case 'audio': {
      throw new ProviderCapabilityError('Anthropic does not support audio parts.', {
        provider: 'anthropic',
      });
    }
    case 'document': {
      if (part.url) {
        const documentBlock: AnthropicDocumentBlock = {
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

      const documentBlock: AnthropicDocumentBlock = {
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
        throw new ProviderCapabilityError(
          'Anthropic tool calls must appear in assistant messages.',
          {
            provider: 'anthropic',
          },
        );
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
        throw new ProviderCapabilityError(
          'Anthropic tool results must appear in user messages.',
          {
            provider: 'anthropic',
          },
        );
      }
      const toolResultBlock: AnthropicToolResultBlock = {
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

function translateAnthropicSystemPrompt(
  systemMessages: CanonicalMessage[],
  explicitSystem: string | undefined,
): AnthropicContentBlock[] | string | undefined {
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
        throw new ProviderCapabilityError(
          'Anthropic system prompts currently support text content only.',
          {
            provider: 'anthropic',
          },
        );
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

function normalizeAnthropicFinishReason(
  finishReason: AnthropicResponsePayload['stop_reason'],
): CanonicalFinishReason {
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

function messageContainsAudio(message: CanonicalMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some((part) => part.type === 'audio')
  );
}

function messageContainsVisionContent(message: CanonicalMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some(
      (part) => part.type === 'image_base64' || part.type === 'image_url',
    )
  );
}

function stringifyToolResult(result: JsonValue): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function buildAnthropicErrorOptions(
  statusCode: number,
  model: string | undefined,
  requestId: string | undefined,
  retryable: boolean,
): {
  model?: string;
  provider: 'anthropic';
  requestId?: string;
  retryable: boolean;
  statusCode: number;
} {
  const options = {
    provider: 'anthropic' as const,
    retryable,
    statusCode,
  };

  return {
    ...options,
    ...(model !== undefined ? { model } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

function buildAnthropicTextBlock(
  text: string,
  cacheControl?: CacheControl,
): AnthropicTextBlock {
  return {
    text,
    type: 'text',
    ...(cacheControl !== undefined ? { cache_control: cacheControl } : {}),
  };
}

function buildCanonicalTextPart(
  text: string,
  cacheControl?: CacheControl,
): CanonicalPart {
  return {
    text,
    type: 'text',
    ...(cacheControl !== undefined ? { cacheControl } : {}),
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
