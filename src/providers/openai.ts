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
  StreamChunk,
} from '../types.js';
import type { RetryOptions } from '../utils/retry.js';

type OpenAIMessage =
  | OpenAIDeveloperMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

interface OpenAIDeveloperMessage {
  content: string;
  role: 'developer';
}

interface OpenAIUserTextPart {
  text: string;
  type: 'text';
}

interface OpenAIUserImagePart {
  image_url: {
    url: string;
  };
  type: 'image_url';
}

type OpenAIUserContentPart = OpenAIUserImagePart | OpenAIUserTextPart;

interface OpenAIUserMessage {
  content: OpenAIUserContentPart[] | string;
  role: 'user';
}

interface OpenAIToolCall {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type: 'function';
}

interface OpenAIAssistantMessage {
  content: null | string;
  role: 'assistant';
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolMessage {
  content: string;
  role: 'tool';
  tool_call_id: string;
}

interface OpenAIToolDefinition {
  function: {
    description: string;
    name: string;
    parameters: CanonicalTool['parameters'];
  };
  type: 'function';
}

type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { function: { name: string }; type: 'function' };

interface OpenAIUsagePayload {
  completion_tokens?: number;
  prompt_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  total_tokens?: number;
}

interface OpenAIChatCompletionPayload {
  choices: Array<{
    finish_reason:
      | 'content_filter'
      | 'function_call'
      | 'length'
      | 'stop'
      | 'tool_calls'
      | null;
    index: number;
    message: {
      annotations?: unknown[];
      content: null | string;
      refusal?: string | null;
      role: 'assistant';
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  created: number;
  id: string;
  model: string;
  object: 'chat.completion';
  usage?: OpenAIUsagePayload;
}

interface OpenAIErrorBody {
  error?: {
    code?: string | null;
    message?: string;
    param?: string | null;
    type?: string;
  };
}

interface OpenAIChunkToolCallDelta {
  function?: {
    arguments?: string;
    name?: string;
  };
  id?: string;
  index: number;
  type?: 'function';
}

interface OpenAIChatCompletionChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      role?: 'assistant';
      tool_calls?: OpenAIChunkToolCallDelta[];
    };
    finish_reason:
      | 'content_filter'
      | 'function_call'
      | 'length'
      | 'stop'
      | 'tool_calls'
      | null;
    index: number;
  }>;
  created: number;
  id: string;
  model: string;
  object: 'chat.completion.chunk';
  usage?: OpenAIUsagePayload;
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
          `${this.baseUrl}/v1/chat/completions`,
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

    const payload = (await response.json()) as OpenAIChatCompletionPayload;
    return translateOpenAIResponse(payload, this.modelRegistry, options.model);
  }

  async *stream(
    options: OpenAICompletionOptions,
  ): AsyncGenerator<StreamChunk, void, void> {
    this.assertCapabilities({ ...options, stream: true });

    const response = await withRetry(
      async () =>
        this.fetchImplementation(
          `${this.baseUrl}/v1/chat/completions`,
          buildRequestInit(
            {
              body: JSON.stringify({
                ...translateOpenAIRequest(options),
                stream: true,
                stream_options: { include_usage: true },
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
      const chunk = JSON.parse(payload) as OpenAIChatCompletionChunk;
      yield* assembler.consume(chunk);
    }

    yield assembler.finish();
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
        `Model "${options.model}" request includes unsupported content parts for the OpenAI chat completions API.`,
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
  const messages: OpenAIMessage[] = [];

  if (options.system) {
    messages.push({
      content: options.system,
      role: 'developer',
    });
  }

  for (const message of options.messages) {
    if (message.role === 'system') {
      messages.push(translateOpenAISystemMessage(message));
      continue;
    }

    messages.push(...translateOpenAIMessage(message));
  }

  const body: Record<string, unknown> = {
    messages,
    model: options.model,
  };

  if (options.maxTokens !== undefined) {
    body.max_completion_tokens = options.maxTokens;
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

  return body;
}

export function translateOpenAITool(tool: CanonicalTool): OpenAIToolDefinition {
  return {
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    },
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
        function: {
          name: toolChoice.name,
        },
        type: 'function',
      },
    };
  }

  return {
    toolChoice: toolChoice.type,
  };
}

export function translateOpenAIResponse(
  payload: OpenAIChatCompletionPayload,
  modelRegistry: ModelRegistry = new ModelRegistry(),
  requestedModel?: string,
): CanonicalResponse {
  const resolvedModelId = resolveOpenAIModelId(payload.model, requestedModel, modelRegistry);
  const model = modelRegistry.get(resolvedModelId);
  const usage = usageWithCost(model, openaiUsageToCanonical(payload.usage));
  const choice = payload.choices[0];
  if (!choice) {
    throw new ProviderError('OpenAI response contained no choices.', {
      model: payload.model,
      provider: 'openai',
    });
  }

  const content: CanonicalPart[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  if (choice.message.content) {
    content.push({
      text: choice.message.content,
      type: 'text',
    });
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    const args = parseOpenAIToolArguments(
      toolCall.function.arguments,
      payload.model,
      toolCall.function.name,
    );
    content.push({
      args,
      id: toolCall.id,
      name: toolCall.function.name,
      type: 'tool_call',
    });
    toolCalls.push({
      args,
      id: toolCall.id,
      name: toolCall.function.name,
    });
  }

  return {
    content,
    finishReason: normalizeOpenAIFinishReason(choice.finish_reason),
    model: resolvedModelId,
    provider: 'openai',
    raw: payload,
    text: choice.message.content ?? '',
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

class OpenAIStreamAssembler {
  private finishReason: CanonicalFinishReason = 'stop';
  private readonly model: string;
  private readonly modelRegistry: ModelRegistry;
  private readonly toolBuffer = new Map<number, { args: string; id: string; name: string }>();
  private usage: OpenAIUsagePayload | undefined;

  constructor(model: string, modelRegistry: ModelRegistry) {
    this.model = model;
    this.modelRegistry = modelRegistry;
  }

  *consume(chunk: OpenAIChatCompletionChunk): Generator<StreamChunk> {
    if (chunk.usage) {
      this.usage = chunk.usage;
    }

    for (const choice of chunk.choices) {
      if (choice.delta.content) {
        yield {
          delta: choice.delta.content,
          type: 'text-delta',
        };
      }

      for (const toolCall of choice.delta.tool_calls ?? []) {
        const current = this.toolBuffer.get(toolCall.index);
        if (!current) {
          const id = toolCall.id ?? `tool_call_${toolCall.index}`;
          const name = toolCall.function?.name ?? `tool_${toolCall.index}`;
          this.toolBuffer.set(toolCall.index, {
            args: '',
            id,
            name,
          });
          yield {
            id,
            name,
            type: 'tool-call-start',
          };
        } else {
          if (toolCall.id) {
            current.id = toolCall.id;
          }
          if (toolCall.function?.name) {
            current.name = toolCall.function.name;
          }
        }

        if (toolCall.function?.arguments) {
          const buffer = this.toolBuffer.get(toolCall.index);
          if (!buffer) {
            continue;
          }
          buffer.args += toolCall.function.arguments;
          yield {
            argsDelta: toolCall.function.arguments,
            id: buffer.id,
            type: 'tool-call-delta',
          };
        }
      }

      if (choice.finish_reason) {
        this.finishReason = normalizeOpenAIFinishReason(choice.finish_reason);
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
          yield* this.flushToolCalls();
        }
      }
    }
  }

  finish(): StreamChunk {
    const model = this.modelRegistry.get(this.model);
    return {
      finishReason: this.finishReason,
      type: 'done',
      usage: usageWithCost(model, openaiUsageToCanonical(this.usage)),
    };
  }

  private *flushToolCalls(): Generator<StreamChunk> {
    for (const [index, tool] of this.toolBuffer.entries()) {
      this.toolBuffer.delete(index);
      yield {
        id: tool.id,
        name: tool.name,
        result: parseOpenAIToolArguments(tool.args, this.model, tool.name),
        type: 'tool-call-result',
      };
    }
  }
}

function translateOpenAISystemMessage(message: CanonicalMessage): OpenAIDeveloperMessage {
  if (typeof message.content === 'string') {
    return {
      content: message.content,
      role: 'developer',
    };
  }

  if (message.content.some((part) => part.type !== 'text')) {
    throw new ProviderCapabilityError(
      'OpenAI developer messages currently support text content only.',
      {
        provider: 'openai',
      },
    );
  }

  const textParts = message.content.filter(
    (part): part is Extract<CanonicalPart, { type: 'text' }> => part.type === 'text',
  );

  return {
    content: textParts.map((part) => part.text).join('\n\n'),
    role: 'developer',
  };
}

function translateOpenAIMessage(message: CanonicalMessage): OpenAIMessage[] {
  switch (message.role) {
    case 'assistant':
      return translateOpenAIAssistantMessage(message);
    case 'system':
      return [translateOpenAISystemMessage(message)];
    case 'user':
      return translateOpenAIUserMessage(message);
  }
}

function translateOpenAIUserMessage(message: CanonicalMessage): OpenAIMessage[] {
  if (typeof message.content === 'string') {
    return [
      {
        content: message.content,
        role: 'user',
      },
    ];
  }

  const userParts: OpenAIUserContentPart[] = [];
  const toolMessages: OpenAIToolMessage[] = [];

  for (const part of message.content) {
    switch (part.type) {
      case 'audio':
      case 'document':
        throw new ProviderCapabilityError(
          'OpenAI chat completions do not support document or audio canonical parts in this adapter.',
          {
            provider: 'openai',
          },
        );
      case 'image_base64':
        userParts.push({
          image_url: {
            url: `data:${part.mediaType};base64,${part.data}`,
          },
          type: 'image_url',
        });
        break;
      case 'image_url':
        userParts.push({
          image_url: {
            url: part.url,
          },
          type: 'image_url',
        });
        break;
      case 'text':
        userParts.push({
          text: part.text,
          type: 'text',
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
        toolMessages.push({
          content: stringifyToolResult(part.result),
          role: 'tool',
          tool_call_id: part.toolCallId,
        });
        break;
    }
  }

  const messages: OpenAIMessage[] = [];
  if (userParts.length > 0) {
    const onlyText = userParts.every((part) => part.type === 'text');
    messages.push({
      content: onlyText
        ? userParts.map((part) => part.text).join('\n\n')
        : userParts,
      role: 'user',
    });
  }

  messages.push(...toolMessages);
  return messages;
}

function translateOpenAIAssistantMessage(message: CanonicalMessage): OpenAIMessage[] {
  if (typeof message.content === 'string') {
    return [
      {
        content: message.content,
        role: 'assistant',
      },
    ];
  }

  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];

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
        textParts.push(part.text);
        break;
      case 'tool_call':
        toolCalls.push({
          function: {
            arguments: JSON.stringify(part.args),
            name: part.name,
          },
          id: part.id,
          type: 'function',
        });
        break;
    }
  }

  if (toolCalls.length > 0) {
    return [
      {
        content: null,
        role: 'assistant',
        tool_calls: toolCalls,
      },
    ];
  }

  return [
    {
      content: textParts.join('\n\n'),
      role: 'assistant',
    },
  ];
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
  finishReason:
    | 'content_filter'
    | 'function_call'
    | 'length'
    | 'stop'
    | 'tool_calls'
    | null,
): CanonicalFinishReason {
  switch (finishReason) {
    case 'content_filter':
      return 'content_filter';
    case 'function_call':
    case 'tool_calls':
      return 'tool_call';
    case 'length':
      return 'length';
    case 'stop':
    case null:
      return 'stop';
  }
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
