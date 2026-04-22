import {
  AuthenticationError,
  ContextLimitError,
  ProviderCapabilityError,
  ProviderError,
  RateLimitError,
} from '../errors.js';
import { ModelRegistry } from '../models/registry.js';
import { openaiUsageToCanonical, usageWithCost } from '../utils/cost.js';
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
  JsonObject,
  JsonValue,
  ProviderOptions,
  RemoteModelInfo,
  StreamChunk,
} from '../types.js';
import type { OpenAIUsagePayload } from '../utils/cost.js';
import type { RetryOptions } from '../utils/retry.js';

type OpenAIInputItem =
  | OpenAIFunctionCallInput
  | OpenAIFunctionCallOutputInput
  | OpenAIMessageInput;

interface OpenAIInputTextPart {
  text: string;
  type: 'input_text';
}

interface OpenAIInputImagePart {
  detail?: 'auto' | 'high' | 'low';
  image_url: string;
  type: 'input_image';
}

type OpenAIInputContentPart = OpenAIInputImagePart | OpenAIInputTextPart;

interface OpenAIMessageInput {
  content: OpenAIInputContentPart[];
  role: 'assistant' | 'user';
  type: 'message';
}

interface OpenAIFunctionCallInput {
  arguments: string;
  call_id: string;
  id?: string;
  name: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'function_call';
}

interface OpenAIFunctionCallOutputInput {
  call_id: string;
  id?: string;
  output: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'function_call_output';
}

interface OpenAIToolDefinition {
  description: string;
  name: string;
  parameters: CanonicalTool['parameters'];
  strict: false;
  type: 'function';
}

type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { name: string; type: 'function' };

interface OpenAIResponseErrorPayload {
  code?: string | null;
  message?: string | null;
  param?: string | null;
  type?: string;
}

interface OpenAIOutputTextPart {
  annotations?: unknown[];
  text: string;
  type: 'output_text';
}

interface OpenAIRefusalPart {
  refusal: string;
  type: 'refusal';
}

type OpenAIOutputMessageContentPart =
  | OpenAIOutputTextPart
  | OpenAIRefusalPart
  | { type: string; [key: string]: unknown };

interface OpenAIMessageOutput {
  content: OpenAIOutputMessageContentPart[];
  id: string;
  role: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'message';
}

interface OpenAIFunctionCallOutput {
  arguments: string;
  call_id: string;
  id: string;
  name: string;
  status?: 'completed' | 'in_progress' | 'incomplete';
  type: 'function_call';
}

type OpenAIOutputItem =
  | OpenAIFunctionCallOutput
  | OpenAIMessageOutput
  | { id?: string; type: string; [key: string]: unknown };

interface OpenAIResponsePayload {
  created_at?: number;
  error?: OpenAIResponseErrorPayload | null;
  id: string;
  incomplete_details?: {
    reason?: string | null;
  } | null;
  model: string;
  object: 'response';
  output?: OpenAIOutputItem[];
  status: 'completed' | 'failed' | 'in_progress' | 'incomplete';
  usage?: OpenAIUsagePayload;
}

interface OpenAIErrorBody {
  error?: OpenAIResponseErrorPayload;
}

interface OpenAIModelPayload {
  created?: number;
  id: string;
  object: string;
  owned_by?: string;
}

interface OpenAIModelListPayload {
  data?: OpenAIModelPayload[];
  object?: string;
}

interface OpenAIResponseOutputTextDeltaEvent {
  content_index: number;
  delta: string;
  item_id: string;
  output_index: number;
  sequence_number: number;
  type: 'response.output_text.delta';
}

interface OpenAIResponseOutputItemAddedEvent {
  item: OpenAIOutputItem;
  output_index: number;
  sequence_number: number;
  type: 'response.output_item.added';
}

interface OpenAIResponseOutputItemDoneEvent {
  item: OpenAIOutputItem;
  output_index: number;
  sequence_number: number;
  type: 'response.output_item.done';
}

interface OpenAIResponseFunctionCallArgumentsDeltaEvent {
  delta: string;
  item_id: string;
  output_index: number;
  sequence_number: number;
  type: 'response.function_call_arguments.delta';
}

interface OpenAIResponseFunctionCallArgumentsDoneEvent {
  arguments: string;
  call_id?: string;
  item_id: string;
  name: string;
  output_index: number;
  sequence_number: number;
  type: 'response.function_call_arguments.done';
}

interface OpenAIResponseCompletedEvent {
  response: OpenAIResponsePayload;
  sequence_number: number;
  type: 'response.completed';
}

interface OpenAIResponseFailedEvent {
  response: OpenAIResponsePayload;
  sequence_number: number;
  type: 'response.failed';
}

interface OpenAIResponseIncompleteEvent {
  response: OpenAIResponsePayload;
  sequence_number: number;
  type: 'response.incomplete';
}

interface OpenAIResponseErrorEvent {
  code?: string | null;
  message?: string;
  param?: string | null;
  type: 'error';
}

export interface OpenAIClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  modelRegistry?: ModelRegistry;
  organization?: string;
  project?: string;
  retryOptions?: RetryOptions;
}

export interface OpenAICompletionOptions {
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

export class OpenAIAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly modelRegistry: ModelRegistry;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;
  private readonly retryOptions: RetryOptions | undefined;

  constructor(config: OpenAIClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com';
    this.fetchImplementation = config.fetchImplementation ?? fetch;
    this.modelRegistry = config.modelRegistry ?? new ModelRegistry();
    this.organization = config.organization;
    this.project = config.project;
    this.retryOptions = config.retryOptions;
  }

  async complete(options: OpenAICompletionOptions): Promise<CanonicalResponse> {
    this.assertCapabilities(options);

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/responses`,
          buildRequestInit(
            {
              body: JSON.stringify(translateOpenAIRequest(options)),
              headers: this.buildHeaders(),
              method: 'POST',
            },
            options.signal,
          ),
        ),
      this.retryOptions,
    );

    if (!response.ok) {
      throw await mapOpenAIError(response, options.model);
    }

    const payload = (await response.json()) as OpenAIResponsePayload;
    return translateOpenAIResponse(payload, this.modelRegistry, options.model);
  }

  async *stream(
    options: OpenAICompletionOptions,
  ): AsyncGenerator<StreamChunk, void, void> {
    this.assertCapabilities({ ...options, stream: true });

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/responses`,
          buildRequestInit(
            {
              body: JSON.stringify({
                ...translateOpenAIRequest(options),
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
      throw await mapOpenAIError(response, options.model);
    }

    if (!response.body) {
      throw new ProviderError('OpenAI streaming response did not include a body.', {
        model: options.model,
        provider: 'openai',
      });
    }

    const assembler = new OpenAIStreamAssembler(options.model, this.modelRegistry);
    for await (const payload of parseSSE(response.body)) {
      const event = JSON.parse(payload) as { [key: string]: unknown; type?: string };
      yield* assembler.consume(event);
    }

    yield assembler.finish();
  }

  async listModels(): Promise<RemoteModelInfo[]> {
    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/models`,
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
      throw await mapOpenAIError(response);
    }

    const payload = (await response.json()) as OpenAIModelListPayload;
    return (payload.data ?? []).map((model) => {
      const createdAt = normalizeUnixTimestamp(model.created);
      return {
        ...(createdAt ? { createdAt } : {}),
        displayName: model.id,
        id: model.id,
        ...(model.owned_by ? { ownedBy: model.owned_by } : {}),
        provider: 'openai',
        raw: model,
      };
    });
  }

  private assertCapabilities(
    options: OpenAICompletionOptions & { stream?: boolean },
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

    if (options.messages.some(messageContainsUnsupportedOpenAIParts)) {
      throw new ProviderCapabilityError(
        `Model "${options.model}" request includes unsupported content parts for the OpenAI Responses API.`,
        {
          model: options.model,
          provider: 'openai',
        },
      );
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(this.organization ? { 'OpenAI-Organization': this.organization } : {}),
      ...(this.project ? { 'OpenAI-Project': this.project } : {}),
    };
  }
}

export function translateOpenAIRequest(
  options: OpenAICompletionOptions,
): Record<string, unknown> {
  const input: OpenAIInputItem[] = [];
  const instructions: string[] = [];
  const promptCaching = options.providerOptions?.openai?.promptCaching;

  if (options.system) {
    instructions.push(options.system);
  }

  for (const message of options.messages) {
    if (message.role === 'system') {
      instructions.push(translateOpenAISystemMessage(message));
      continue;
    }

    input.push(...translateOpenAIMessage(message));
  }

  const body: Record<string, unknown> = {
    input,
    model: options.model,
    store: false,
  };

  if (instructions.length > 0) {
    body.instructions = instructions.join('\n\n');
  }

  if (options.maxTokens !== undefined) {
    body.max_output_tokens = options.maxTokens;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map(translateOpenAITool);
  }

  if (options.toolChoice) {
    const mappedChoice = translateOpenAIToolChoice(options.toolChoice);
    body.tool_choice = mappedChoice.toolChoice;
    if (mappedChoice.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = mappedChoice.parallelToolCalls;
    }
  }

  if (promptCaching?.key) {
    body.prompt_cache_key = promptCaching.key;
  }

  if (promptCaching?.retention) {
    body.prompt_cache_retention = promptCaching.retention;
  }

  return body;
}

export function translateOpenAITool(tool: CanonicalTool): OpenAIToolDefinition {
  return {
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters,
    strict: false,
    type: 'function',
  };
}

export function translateOpenAIToolChoice(toolChoice: CanonicalToolChoice): {
  parallelToolCalls?: boolean;
  toolChoice: OpenAIToolChoice;
} {
  if (toolChoice.type === 'any') {
    return {
      toolChoice: 'required',
    };
  }

  if (toolChoice.type === 'tool') {
    return {
      ...(toolChoice.disableParallelToolUse !== undefined
        ? { parallelToolCalls: !toolChoice.disableParallelToolUse }
        : {}),
      toolChoice: {
        name: toolChoice.name,
        type: 'function',
      },
    };
  }

  return {
    toolChoice: toolChoice.type,
  };
}

export function translateOpenAIResponse(
  payload: OpenAIResponsePayload,
  modelRegistry: ModelRegistry = new ModelRegistry(),
  requestedModel?: string,
): CanonicalResponse {
  const resolvedModelId = resolveOpenAIModelId(payload.model, requestedModel, modelRegistry);
  const model = modelRegistry.get(resolvedModelId);
  const usage = usageWithCost(model, openaiUsageToCanonical(payload.usage));
  const content: CanonicalPart[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  const textSegments: string[] = [];

  for (const item of payload.output ?? []) {
    if (isOpenAIMessageOutput(item) && item.role === 'assistant') {
      for (const part of item.content) {
        if (isOpenAIOutputTextPart(part)) {
          content.push({
            text: part.text,
            type: 'text',
          });
          textSegments.push(part.text);
          continue;
        }

        if (isOpenAIRefusalPart(part)) {
          content.push({
            text: part.refusal,
            type: 'text',
          });
          textSegments.push(part.refusal);
        }
      }
      continue;
    }

    if (isOpenAIFunctionCallOutput(item)) {
      const args = parseOpenAIToolArguments(
        item.arguments,
        payload.model,
        item.name,
      );
      content.push({
        args,
        id: item.call_id,
        name: item.name,
        type: 'tool_call',
      });
      toolCalls.push({
        args,
        id: item.call_id,
        name: item.name,
      });
    }
  }

  return {
    content,
    finishReason: normalizeOpenAIFinishReason(payload),
    model: resolvedModelId,
    provider: 'openai',
    raw: payload,
    text: textSegments.join(''),
    toolCalls,
    usage,
  };
}

function resolveOpenAIModelId(
  responseModel: string,
  requestedModel: string | undefined,
  modelRegistry: ModelRegistry,
): string {
  if (modelRegistry.isSupported(responseModel)) {
    return responseModel;
  }

  if (requestedModel && modelRegistry.isSupported(requestedModel)) {
    return requestedModel;
  }

  return responseModel;
}

export async function mapOpenAIError(
  response: Response,
  model?: string,
): Promise<AuthenticationError | ContextLimitError | ProviderError | RateLimitError> {
  const requestId =
    response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
  let body: OpenAIErrorBody | undefined;
  try {
    body = (await response.json()) as OpenAIErrorBody;
  } catch {
    body = undefined;
  }

  const message = body?.error?.message ?? `OpenAI request failed with ${response.status}.`;
  const code = body?.error?.code ?? undefined;
  const options = buildOpenAIErrorOptions(
    response.status,
    model,
    requestId,
    response.status === 429 || response.status >= 500,
  );

  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(message, options);
  }

  if (response.status === 429) {
    return new RateLimitError(message, options);
  }

  if (
    response.status === 400 &&
    (code === 'context_length_exceeded' || /context|token/i.test(message))
  ) {
    return new ContextLimitError(message, {
      ...options,
      retryable: false,
    });
  }

  return new ProviderError(message, options);
}

function normalizeUnixTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}

class OpenAIStreamAssembler {
  private finalResponse: OpenAIResponsePayload | undefined;
  private finishReason: CanonicalFinishReason = 'stop';
  private readonly model: string;
  private readonly modelRegistry: ModelRegistry;
  private readonly toolBuffer = new Map<
    string,
    { args: string; callId: string; name: string }
  >();

  constructor(model: string, modelRegistry: ModelRegistry) {
    this.model = model;
    this.modelRegistry = modelRegistry;
  }

  *consume(event: { [key: string]: unknown; type?: string }): Generator<StreamChunk> {
    switch (event.type) {
      case 'response.output_text.delta': {
        const typedEvent = event as unknown as OpenAIResponseOutputTextDeltaEvent;
        if (typedEvent.delta.length > 0) {
          yield {
            delta: typedEvent.delta,
            type: 'text-delta',
          };
        }
        return;
      }
      case 'response.output_item.added': {
        const typedEvent = event as unknown as OpenAIResponseOutputItemAddedEvent;
        yield* this.handleOutputItemAdded(typedEvent.item, typedEvent.output_index);
        return;
      }
      case 'response.function_call_arguments.delta':
        yield* this.handleFunctionCallArgumentsDelta(
          event as unknown as OpenAIResponseFunctionCallArgumentsDeltaEvent,
        );
        return;
      case 'response.function_call_arguments.done':
        this.handleFunctionCallArgumentsDone(
          event as unknown as OpenAIResponseFunctionCallArgumentsDoneEvent,
        );
        return;
      case 'response.output_item.done': {
        const typedEvent = event as unknown as OpenAIResponseOutputItemDoneEvent;
        yield* this.handleOutputItemDone(typedEvent.item, typedEvent.output_index);
        return;
      }
      case 'response.completed':
      case 'response.incomplete':
        this.finalResponse = (
          event as unknown as OpenAIResponseCompletedEvent | OpenAIResponseIncompleteEvent
        ).response;
        this.finishReason = normalizeOpenAIFinishReason(this.finalResponse);
        return;
      case 'response.failed':
        this.finalResponse = (event as unknown as OpenAIResponseFailedEvent).response;
        this.finishReason = normalizeOpenAIFinishReason(this.finalResponse);
        throw this.buildStreamError(this.finalResponse.error);
      case 'error':
        throw this.buildStreamError(event as unknown as OpenAIResponseErrorEvent);
      default:
        return;
    }
  }

  finish(): StreamChunk {
    const responseModel = this.finalResponse?.model ?? this.model;
    const resolvedModelId = resolveOpenAIModelId(
      responseModel,
      this.model,
      this.modelRegistry,
    );
    const model = this.modelRegistry.get(resolvedModelId);
    return {
      finishReason: this.finishReason,
      type: 'done',
      usage: usageWithCost(model, openaiUsageToCanonical(this.finalResponse?.usage)),
    };
  }

  private buildStreamError(
    error: OpenAIResponseErrorPayload | null | undefined,
  ): ProviderError {
    return new ProviderError(error?.message ?? 'OpenAI streaming request failed.', {
      model: this.model,
      provider: 'openai',
    });
  }

  private *handleOutputItemAdded(
    item: OpenAIOutputItem,
    outputIndex: number,
  ): Generator<StreamChunk> {
    if (!isOpenAIFunctionCallOutput(item)) {
      return;
    }

    const existing = this.toolBuffer.get(item.id);
    if (existing) {
      existing.callId = item.call_id;
      existing.name = item.name;
      if (item.arguments.length > existing.args.length) {
        existing.args = item.arguments;
      }
      return;
    }

    this.toolBuffer.set(item.id, {
      args: item.arguments,
      callId: item.call_id,
      name: item.name,
    });
    yield {
      id: item.call_id,
      name: item.name,
      type: 'tool-call-start',
    };

    if (item.arguments.length > 0) {
      yield {
        argsDelta: item.arguments,
        id: item.call_id,
        type: 'tool-call-delta',
      };
    }

    void outputIndex;
  }

  private *handleFunctionCallArgumentsDelta(
    event: OpenAIResponseFunctionCallArgumentsDeltaEvent,
  ): Generator<StreamChunk> {
    const tool = this.getOrCreateToolBuffer(event.item_id, event.output_index);
    tool.args += event.delta;
    yield {
      argsDelta: event.delta,
      id: tool.callId,
      type: 'tool-call-delta',
    };
  }

  private handleFunctionCallArgumentsDone(
    event: OpenAIResponseFunctionCallArgumentsDoneEvent,
  ): void {
    const tool = this.getOrCreateToolBuffer(event.item_id, event.output_index);
    tool.args = event.arguments;
    tool.name = event.name;
    if (event.call_id) {
      tool.callId = event.call_id;
    }
  }

  private *handleOutputItemDone(
    item: OpenAIOutputItem,
    outputIndex: number,
  ): Generator<StreamChunk> {
    if (!isOpenAIFunctionCallOutput(item)) {
      return;
    }

    const tool = this.getOrCreateToolBuffer(item.id, outputIndex);
    tool.args = item.arguments;
    tool.callId = item.call_id;
    tool.name = item.name;
    this.toolBuffer.delete(item.id);
    this.finishReason = 'tool_call';
    yield {
      id: tool.callId,
      name: tool.name,
      result: parseOpenAIToolArguments(tool.args, this.model, tool.name),
      type: 'tool-call-result',
    };
  }

  private getOrCreateToolBuffer(
    itemId: string,
    outputIndex: number,
  ): { args: string; callId: string; name: string } {
    const existing = this.toolBuffer.get(itemId);
    if (existing) {
      return existing;
    }

    const created = {
      args: '',
      callId: itemId,
      name: `tool_${outputIndex}`,
    };
    this.toolBuffer.set(itemId, created);
    return created;
  }
}

function translateOpenAISystemMessage(message: CanonicalMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (message.content.some((part) => part.type !== 'text')) {
    throw new ProviderCapabilityError(
      'OpenAI instructions currently support text content only.',
      {
        provider: 'openai',
      },
    );
  }

  const textParts = message.content.filter(
    (part): part is Extract<CanonicalPart, { type: 'text' }> => part.type === 'text',
  );

  return textParts.map((part) => part.text).join('\n\n');
}

function translateOpenAIMessage(message: CanonicalMessage): OpenAIInputItem[] {
  switch (message.role) {
    case 'assistant':
      return translateOpenAIAssistantMessage(message);
    case 'system':
      return [];
    case 'user':
      return translateOpenAIUserMessage(message);
  }
}

function translateOpenAIUserMessage(message: CanonicalMessage): OpenAIInputItem[] {
  if (typeof message.content === 'string') {
    return [
      {
        content: [
          {
            text: message.content,
            type: 'input_text',
          },
        ],
        role: 'user',
        type: 'message',
      },
    ];
  }

  const userParts: OpenAIInputContentPart[] = [];
  const items: OpenAIInputItem[] = [];

  for (const part of message.content) {
    switch (part.type) {
      case 'audio':
      case 'document':
        throw new ProviderCapabilityError(
          'OpenAI Responses do not support document or audio canonical parts in this adapter.',
          {
            provider: 'openai',
          },
        );
      case 'image_base64':
        userParts.push({
          image_url: `data:${part.mediaType};base64,${part.data}`,
          type: 'input_image',
        });
        break;
      case 'image_url':
        userParts.push({
          image_url: part.url,
          type: 'input_image',
        });
        break;
      case 'text':
        userParts.push({
          text: part.text,
          type: 'input_text',
        });
        break;
      case 'tool_call':
        throw new ProviderCapabilityError(
          'OpenAI tool calls must appear in assistant messages.',
          {
            provider: 'openai',
          },
        );
      case 'tool_result':
        items.push({
          call_id: part.toolCallId,
          output: stringifyToolResult(part.result),
          type: 'function_call_output',
        });
        break;
    }
  }

  if (userParts.length > 0) {
    items.unshift({
      content: userParts,
      role: 'user',
      type: 'message',
    });
  }

  return items;
}

function translateOpenAIAssistantMessage(message: CanonicalMessage): OpenAIInputItem[] {
  if (typeof message.content === 'string') {
    return [
      {
        content: [
          {
            text: message.content,
            type: 'input_text',
          },
        ],
        role: 'assistant',
        type: 'message',
      },
    ];
  }

  const items: OpenAIInputItem[] = [];
  const textParts: OpenAIInputContentPart[] = [];

  for (const part of message.content) {
    switch (part.type) {
      case 'audio':
      case 'document':
      case 'image_base64':
      case 'image_url':
      case 'tool_result':
        throw new ProviderCapabilityError(
          'Assistant messages in the OpenAI adapter support text and tool-call parts only.',
          {
            provider: 'openai',
          },
        );
      case 'text':
        textParts.push({
          text: part.text,
          type: 'input_text',
        });
        break;
      case 'tool_call':
        items.push({
          arguments: JSON.stringify(part.args),
          call_id: part.id,
          name: part.name,
          type: 'function_call',
        });
        break;
    }
  }

  if (textParts.length > 0) {
    items.unshift({
      content: textParts,
      role: 'assistant',
      type: 'message',
    });
  }

  return items;
}

function parseOpenAIToolArguments(
  argumentsJson: string,
  model: string,
  toolName: string,
): JsonObject {
  try {
    const parsed = JSON.parse(argumentsJson) as JsonValue;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Parsed tool arguments were not an object.');
    }

    return parsed;
  } catch (error) {
    throw new ProviderError(
      `Failed to parse OpenAI tool arguments for "${toolName}".`,
      {
        cause: error,
        model,
        provider: 'openai',
      },
    );
  }
}

function normalizeOpenAIFinishReason(
  payload: Pick<OpenAIResponsePayload, 'error' | 'incomplete_details' | 'output' | 'status'>,
): CanonicalFinishReason {
  if ((payload.output ?? []).some(isOpenAIFunctionCallOutput)) {
    return 'tool_call';
  }

  if (payload.error || payload.status === 'failed') {
    return 'error';
  }

  const reason = payload.incomplete_details?.reason ?? '';
  if (reason.length > 0) {
    if (/content|filter|policy|safety/i.test(reason)) {
      return 'content_filter';
    }

    if (/length|max|token/i.test(reason)) {
      return 'length';
    }
  }

  if (payload.status === 'incomplete') {
    return 'length';
  }

  return 'stop';
}

function isOpenAIFunctionCallOutput(item: OpenAIOutputItem): item is OpenAIFunctionCallOutput {
  return item.type === 'function_call';
}

function isOpenAIMessageOutput(item: OpenAIOutputItem): item is OpenAIMessageOutput {
  return item.type === 'message';
}

function isOpenAIOutputTextPart(
  part: OpenAIOutputMessageContentPart,
): part is OpenAIOutputTextPart {
  return part.type === 'output_text';
}

function isOpenAIRefusalPart(
  part: OpenAIOutputMessageContentPart,
): part is OpenAIRefusalPart {
  return part.type === 'refusal';
}

function messageContainsUnsupportedOpenAIParts(message: CanonicalMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    message.content.some(
      (part) => part.type === 'audio' || part.type === 'document',
    )
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

function buildOpenAIErrorOptions(
  statusCode: number,
  model: string | undefined,
  requestId: string | undefined,
  retryable: boolean,
): {
  model?: string;
  provider: 'openai';
  requestId?: string;
  retryable: boolean;
  statusCode: number;
} {
  return {
    provider: 'openai',
    retryable,
    statusCode,
    ...(model !== undefined ? { model } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
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

function stringifyToolResult(result: JsonValue): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}
