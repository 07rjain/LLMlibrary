import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from 'unified-llm-client/errors';
import { ModelRegistry } from 'unified-llm-client/models';
import { validateAnthropicCacheControls } from '../cache-validation.js';
import {
  discoveryError,
  isPlainObject,
  readModelDiscoveryPage,
  readOptionalString,
  readPaginationCursor,
  readRequiredModelId,
} from '../model-discovery.js';
import { anthropicUsageToCanonical, usageWithCost } from '../utils/cost.js';
import {
  validateAndCloneTool,
  validateAndCloneTools,
} from '../tool-validation.js';
import { buildAnthropicOutputConfig } from '../structured-output.js';
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
  AnthropicThinkingEffort,
  AnthropicThinkingOptions,
  ProviderOptions,
  RemoteModelInfo,
  ResponseFormat,
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
  stop_reason:
    | 'end_turn'
    | 'max_tokens'
    | 'refusal'
    | 'stop_sequence'
    | 'tool_use'
    | null;
  usage?: AnthropicUsage;
}

interface AnthropicErrorBody {
  error?: {
    message?: string;
    type?: string;
  };
  type?: 'error';
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
  responseFormat?: ResponseFormat;
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

  async complete(
    options: AnthropicCompletionOptions,
  ): Promise<CanonicalResponse> {
    this.assertCapabilities(options);
    throwIfAborted(options.signal);

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
      options.signal,
    );

    if (!response.ok) {
      throw await mapAnthropicError(response, options.model);
    }

    const context = anthropicResponseContext(response, options, 'complete');
    const payload = await readProviderJson(response, context);
    validateAnthropicResponsePayload(payload, context);
    return translateAnthropicResponse(
      payload,
      this.modelRegistry,
      options.model,
    );
  }

  async *stream(
    options: AnthropicCompletionOptions,
  ): AsyncGenerator<StreamChunk, void, void> {
    this.assertCapabilities({ ...options, stream: true });
    throwIfAborted(options.signal);

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
      options.signal,
    );

    if (!response.ok) {
      throw await mapAnthropicError(response, options.model);
    }

    if (!response.body) {
      throw new ProviderError(
        'Anthropic streaming response did not include a body.',
        {
          model: options.model,
          provider: 'anthropic',
        },
      );
    }

    const context = anthropicResponseContext(response, options, 'stream');
    assertProviderContentType(response, context, 'sse');
    const assembler = new AnthropicStreamAssembler(
      options.model,
      this.modelRegistry,
      context,
    );

    for await (const payload of parseSSE(response.body, options.signal)) {
      throwIfAborted(options.signal);
      const event = parseProviderEvent(payload, context);
      assertProviderObject(event, context, 'event');
      assertProviderString(event.type, context, 'event.type');
      validateAnthropicStreamEvent(event, context);
      yield* assembler.consume(event as unknown as AnthropicSSEEvent);
    }

    throwIfAborted(options.signal);
    const doneChunk = assembler.finish();
    if (doneChunk) {
      yield doneChunk;
    }
  }

  async listModels(): Promise<RemoteModelInfo[]> {
    const models: RemoteModelInfo[] = [];
    let afterId: string | undefined;
    const seenCursors = new Set<string>();

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

      const { page, records } = await readModelDiscoveryPage(
        response,
        'anthropic',
        'data',
      );
      for (const model of records) {
        const id = readRequiredModelId(model, 'id');
        if (!id || !isPlainObject(model)) {
          continue;
        }
        const createdAt = readOptionalString(model, 'created_at');
        const displayName = readOptionalString(model, 'display_name');
        models.push({
          ...(createdAt ? { createdAt } : {}),
          ...(displayName ? { displayName } : {}),
          id,
          provider: 'anthropic',
          raw: model,
        });
      }

      if (typeof page.has_more !== 'boolean') {
        throw discoveryError('anthropic', 'has_more', 'boolean');
      }
      if (!page.has_more) {
        return models;
      }

      afterId = readPaginationCursor(
        page.last_id,
        seenCursors,
        'anthropic',
        'last_id',
      );
    }
  }

  private assertCapabilities(
    options: AnthropicCompletionOptions & { stream?: boolean },
  ): void {
    const effort = options.providerOptions?.anthropic?.effort as unknown;
    if (effort !== undefined) {
      assertAnthropicThinkingEffort(effort, options.model);
      const model = this.modelRegistry.get(options.model);
      const supportedEfforts = model.supportedReasoningEfforts;

      if (!supportedEfforts?.includes(effort)) {
        throw new ProviderCapabilityError(
          `Model "${options.model}" does not support Anthropic reasoning effort "${effort}".`,
          {
            details: {
              effort,
              supportedReasoningEfforts: supportedEfforts ?? [],
            },
            model: options.model,
            provider: model.provider,
          },
        );
      }
    }

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
  const validatedTools =
    options.tools === undefined
      ? undefined
      : validateAndCloneTools(options.tools, 'anthropic', options.model);
  const validatedCacheControl = validateAnthropicCacheControls({
    messages: options.messages,
    model: options.model,
    providerOptions: options.providerOptions,
  });
  const systemMessages = options.messages.filter(
    (message) => message.role === 'system',
  );
  const nonSystemMessages = options.messages.filter(
    (message) => message.role !== 'system',
  );
  const anthropicOptions = options.providerOptions?.anthropic;

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

  let outputConfig = buildAnthropicOutputConfig(options.responseFormat);
  const effort = anthropicOptions?.effort as unknown;
  if (effort !== undefined) {
    assertAnthropicThinkingEffort(effort, options.model);
    outputConfig = {
      ...outputConfig,
      effort,
    };
  }

  if (outputConfig !== undefined) {
    body.output_config = outputConfig;
  }

  if (validatedTools && validatedTools.length > 0) {
    body.tools = validatedTools.map(translateAnthropicToolDefinition);
  }

  if (options.toolChoice) {
    body.tool_choice = translateAnthropicToolChoice(options.toolChoice);
  }

  if (validatedCacheControl) {
    body.cache_control = validatedCacheControl;
  }

  if (anthropicOptions?.thinking) {
    body.thinking = translateAnthropicThinking(
      anthropicOptions.thinking,
      options.maxTokens,
      options.model,
    );
  }

  return body;
}

const ANTHROPIC_THINKING_EFFORTS: readonly AnthropicThinkingEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function assertAnthropicThinkingEffort(
  effort: unknown,
  model: string,
): asserts effort is AnthropicThinkingEffort {
  if (
    typeof effort !== 'string' ||
    !ANTHROPIC_THINKING_EFFORTS.includes(effort as AnthropicThinkingEffort)
  ) {
    throw new ProviderCapabilityError('Invalid Anthropic reasoning effort.', {
      details: {
        effort,
        supportedReasoningEfforts: ANTHROPIC_THINKING_EFFORTS,
      },
      model,
      provider: 'anthropic',
    });
  }
}

function translateAnthropicThinking(
  thinking: AnthropicThinkingOptions,
  maxTokens: number | undefined,
  model: string,
): Record<string, unknown> {
  const budgetTokens = thinking.budgetTokens;

  if (budgetTokens !== undefined) {
    const constraint =
      thinking.type !== 'enabled'
        ? 'enabled_only'
        : !Number.isSafeInteger(budgetTokens)
          ? 'safe_integer'
          : budgetTokens < 0
            ? 'non_negative'
            : maxTokens === undefined
              ? 'requires_max_tokens'
              : budgetTokens >= maxTokens
                ? 'below_max_tokens'
                : undefined;

    if (constraint) {
      throw new ProviderCapabilityError('Invalid thinking budget.', {
        details: {
          budgetTokens,
          constraint,
          maxTokens,
        },
        model,
        provider: 'anthropic',
      });
    }
  }

  const body: Record<string, unknown> = {
    type: thinking.type,
  };
  if (budgetTokens !== undefined) {
    body.budget_tokens = budgetTokens;
  }
  if (thinking.display !== undefined) {
    body.display = thinking.display;
  }
  return body;
}

export function translateAnthropicTool(
  tool: CanonicalTool,
): AnthropicToolDefinition {
  return translateAnthropicToolDefinition(
    validateAndCloneTool(tool, 'anthropic'),
  );
}

function translateAnthropicToolDefinition(
  tool: CanonicalTool,
): AnthropicToolDefinition {
  return {
    ...(tool.cacheControl !== undefined
      ? { cache_control: tool.cacheControl }
      : {}),
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
      mappedChoice.disable_parallel_tool_use =
        toolChoice.disableParallelToolUse;
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
    ...(payload.stop_reason === 'refusal'
      ? {
          refusal: text,
          structuredOutputStatus: 'refusal' as const,
        }
      : {}),
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
): Promise<
  AuthenticationError | ContextLimitError | ProviderError | RateLimitError
> {
  const requestId =
    response.headers.get('anthropic-request-id') ??
    response.headers.get('request-id') ??
    undefined;
  let body: AnthropicErrorBody | undefined;

  try {
    body = (await response.json()) as AnthropicErrorBody;
  } catch {
    body = undefined;
  }

  const message =
    body?.error?.message ?? `Anthropic request failed with ${response.status}.`;
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

function anthropicResponseContext(
  response: Response,
  options: { model?: string; signal?: AbortSignal },
  operation: string,
) {
  return {
    ...(options.model ? { model: options.model } : {}),
    operation,
    provider: 'anthropic' as const,
    requestId:
      response.headers.get('request-id') ??
      response.headers.get('x-request-id') ??
      undefined,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function validateAnthropicResponsePayload(
  value: unknown,
  context: ReturnType<typeof anthropicResponseContext>,
): asserts value is AnthropicResponsePayload {
  assertProviderObject(value, context, 'response');
  assertProviderString(value.model, context, 'response.model');
  assertProviderArray(value.content, context, 'response.content');
  if (value.stop_reason !== null) {
    assertProviderString(
      value.stop_reason,
      context,
      'response.stop_reason',
    );
  }
  if (
    context.operation === 'complete' &&
    value.content.length === 0 &&
    value.stop_reason !== 'refusal'
  ) {
    throw invalidProviderResponse(context, {
      expected: 'non_empty_array',
      path: 'response.content',
      phase: 'schema',
    });
  }
  for (const [index, block] of value.content.entries()) {
    assertProviderObject(block, context, `response.content[${index}]`);
    assertProviderString(
      block.type,
      context,
      `response.content[${index}].type`,
    );
    if (block.type === 'text') {
      assertProviderString(
        block.text,
        context,
        `response.content[${index}].text`,
      );
    } else if (block.type === 'tool_use') {
      assertProviderString(
        block.id,
        context,
        `response.content[${index}].id`,
      );
      assertProviderString(
        block.name,
        context,
        `response.content[${index}].name`,
      );
      assertProviderObject(
        block.input,
        context,
        `response.content[${index}].input`,
      );
    }
  }
  assertProviderUsage(
    value.usage,
    [
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'input_tokens',
      'output_tokens',
    ],
    context,
    'response.usage',
  );
}

function validateAnthropicStreamEvent(
  event: Record<string, unknown>,
  context: ReturnType<typeof anthropicResponseContext>,
): void {
  const requireIndex = (): void => {
    if (
      typeof event.index !== 'number' ||
      !Number.isSafeInteger(event.index) ||
      event.index < 0
    ) {
      throw invalidProviderResponse(context, {
        expected: 'non_negative_safe_integer',
        path: 'event.index',
        phase: 'schema',
      });
    }
  };
  switch (event.type) {
    case 'message_start':
      validateAnthropicResponsePayload(event.message, context);
      return;
    case 'content_block_start':
      requireIndex();
      assertProviderObject(event.content_block, context, 'event.content_block');
      assertProviderString(
        event.content_block.type,
        context,
        'event.content_block.type',
      );
      if (event.content_block.type === 'tool_use') {
        assertProviderString(
          event.content_block.id,
          context,
          'event.content_block.id',
        );
        assertProviderString(
          event.content_block.name,
          context,
          'event.content_block.name',
        );
      }
      return;
    case 'content_block_delta':
      requireIndex();
      assertProviderObject(event.delta, context, 'event.delta');
      assertProviderString(event.delta.type, context, 'event.delta.type');
      if (event.delta.type === 'text_delta') {
        assertProviderString(event.delta.text, context, 'event.delta.text');
      } else if (event.delta.type === 'input_json_delta') {
        assertProviderString(
          event.delta.partial_json,
          context,
          'event.delta.partial_json',
        );
      }
      return;
    case 'content_block_stop':
      requireIndex();
      return;
    case 'message_delta':
      assertProviderObject(event.delta, context, 'event.delta');
      if (event.delta.stop_reason !== null) {
        assertProviderString(
          event.delta.stop_reason,
          context,
          'event.delta.stop_reason',
        );
      }
      assertProviderUsage(
        event.usage,
        ['output_tokens'],
        context,
        'event.usage',
      );
      return;
    default:
      return;
  }
}

class AnthropicStreamAssembler {
  private readonly context: ReturnType<typeof anthropicResponseContext>;
  private finishReason: CanonicalFinishReason = 'stop';
  private readonly model: string;
  private readonly modelRegistry: ModelRegistry;
  private started = false;
  private outputObserved = false;
  private toolBuffer = new Map<
    number,
    { id: string; json: string; name: string }
  >();
  private usage: AnthropicUsage = {};
  private terminal = false;

  constructor(
    model: string,
    modelRegistry: ModelRegistry,
    context: ReturnType<typeof anthropicResponseContext>,
  ) {
    this.model = model;
    this.modelRegistry = modelRegistry;
    this.context = context;
  }

  *consume(event: AnthropicSSEEvent): Generator<StreamChunk> {
    switch (event.type) {
      case 'message_start':
        this.started = true;
        this.usage = event.message?.usage ?? {};
        return;
      case 'content_block_start':
        if (
          event.content_block?.type === 'tool_use' &&
          event.index !== undefined
        ) {
          this.outputObserved = true;
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
        } else if (
          event.content_block &&
          event.content_block.type !== 'text'
        ) {
          this.outputObserved = true;
        }
        return;
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          this.outputObserved = true;
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
        this.terminal = true;
        return;
    }
  }

  finish(): StreamChunk | null {
    if (!this.started || !this.terminal || this.toolBuffer.size > 0) {
      throw invalidProviderResponse(this.context, {
        expected: 'message_stop_with_complete_tool_calls',
        phase: 'stream',
      });
    }
    if (!this.outputObserved && this.finishReason !== 'content_filter') {
      throw invalidProviderResponse(this.context, {
        expected: 'non_empty_content',
        path: 'response.content',
        phase: 'stream',
      });
    }
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
    let parsed: JsonValue;
    try {
      parsed = tool.json ? (JSON.parse(tool.json) as JsonValue) : {};
    } catch {
      throw invalidProviderResponse(this.context, {
        expected: 'json_object',
        path: 'content_block.input',
        phase: 'schema',
      });
    }
    if (!isPlainObject(parsed)) {
      throw new ProviderError(
        'Anthropic returned invalid tool-call arguments.',
        {
          details: {
            code: 'invalid_provider_response',
            operation: 'stream',
            path: 'content_block.input',
            phase: 'schema',
          },
          model: this.model,
          provider: 'anthropic',
          retryable: false,
          statusCode: 502,
        },
      );
    }
    yield {
      args: parsed,
      id: tool.id,
      name: tool.name,
      type: 'tool-call-arguments',
    };
  }
}

function translateAnthropicMessage(
  message: CanonicalMessage,
): AnthropicMessage {
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
      throw new ProviderCapabilityError(
        'Anthropic does not support audio parts.',
        {
          provider: 'anthropic',
        },
      );
    }
    case 'document': {
      if (part.url) {
        const documentBlock: AnthropicDocumentBlock = {
          ...(part.cacheControl !== undefined
            ? { cache_control: part.cacheControl }
            : {}),
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
        throw new ProviderCapabilityError(
          'Anthropic documents require data or a URL.',
          {
            provider: 'anthropic',
          },
        );
      }

      const documentBlock: AnthropicDocumentBlock = {
        ...(part.cacheControl !== undefined
          ? { cache_control: part.cacheControl }
          : {}),
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
        ...(part.cacheControl !== undefined
          ? { cache_control: part.cacheControl }
          : {}),
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
        ...(part.cacheControl !== undefined
          ? { cache_control: part.cacheControl }
          : {}),
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
        ...(part.cacheControl !== undefined
          ? { cache_control: part.cacheControl }
          : {}),
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
        ...(part.cacheControl !== undefined
          ? { cache_control: part.cacheControl }
          : {}),
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
    case 'refusal':
      return 'content_filter';
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
