import { BudgetExceededError, MaxToolRoundsError, ProviderError } from './errors.js';
import { formatCost } from './utils/cost.js';

import type { ContextManager } from './context-manager.js';
import type { SessionStore } from './session-store.js';
import type {
  CanonicalMessage,
  CanonicalPart,
  CanonicalProvider,
  CanonicalResponse,
  CanonicalTool,
  CanonicalToolChoice,
  JsonObject,
  JsonValue,
  StreamChunk,
  UsageMetrics,
} from './types.js';

const DEFAULT_MAX_TOOL_ROUNDS = 5;
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 30_000;

/** Minimal client contract consumed by `Conversation`. */
export interface ConversationClient {
  complete(options: {
    budgetUsd?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    sessionId?: string;
    signal?: AbortSignal;
    system?: string;
    tenantId?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
  }): Promise<CanonicalResponse>;
  stream(options: {
    budgetUsd?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    sessionId?: string;
    signal?: AbortSignal;
    system?: string;
    tenantId?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
  }): AsyncIterable<StreamChunk>;
}

/** Serializable conversation state persisted by session stores. */
export interface ConversationSnapshot {
  budgetUsd?: number;
  createdAt: string;
  maxToolRounds?: number;
  maxContextTokens?: number;
  maxTokens?: number;
  messages: CanonicalMessage[];
  model?: string;
  provider?: CanonicalProvider;
  sessionId: string;
  system?: string;
  tenantId?: string;
  toolExecutionTimeoutMs?: number;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
  totalCachedTokens: number;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  updatedAt: string;
}

/** Configuration for a new or restored `Conversation`. */
export interface ConversationOptions {
  budgetUsd?: number;
  contextManager?: ContextManager;
  maxToolRounds?: number;
  maxContextTokens?: number;
  maxTokens?: number;
  messages?: CanonicalMessage[];
  model?: string;
  provider?: CanonicalProvider;
  sessionId?: string;
  store?: SessionStore<ConversationSnapshot>;
  system?: string;
  tenantId?: string;
  toolExecutionTimeoutMs?: number;
  toolChoice?: CanonicalToolChoice;
  tools?: CanonicalTool[];
}

/**
 * Stateful conversation wrapper that handles history, tool execution,
 * persistence, and running token/cost totals.
 *
 * @example
 * ```ts
 * const conversation = await client.conversation({
 *   sessionId: 'support-1',
 *   system: 'Be concise.',
 * });
 *
 * await conversation.send('Summarise the issue.');
 * ```
 */
export class Conversation {
  private readonly client: ConversationClient;
  private readonly contextManager: ContextManager | undefined;
  private createdAt: string;
  private readonly budgetUsd: number | undefined;
  private readonly maxToolRounds: number;
  private readonly maxContextTokens: number | undefined;
  private readonly maxTokens: number | undefined;
  private messages: CanonicalMessage[];
  private model: string | undefined;
  private provider: CanonicalProvider | undefined;
  private readonly sessionId: string;
  private readonly store: SessionStore<ConversationSnapshot> | undefined;
  private system: string | undefined;
  private readonly tenantId: string | undefined;
  private readonly toolExecutionTimeoutMs: number;
  private readonly toolChoice: CanonicalToolChoice | undefined;
  private readonly tools: CanonicalTool[] | undefined;
  private totalCachedTokens = 0;
  private totalCostUSD = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private updatedAt: string;

  constructor(client: ConversationClient, options: ConversationOptions = {}) {
    this.client = client;
    this.contextManager = options.contextManager;
    this.budgetUsd = options.budgetUsd;
    this.createdAt = new Date().toISOString();
    this.maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.maxContextTokens = options.maxContextTokens;
    this.maxTokens = options.maxTokens;
    this.messages = cloneValue(options.messages ?? []);
    this.model = options.model;
    this.provider = options.provider;
    this.sessionId = options.sessionId ?? generateSessionId();
    this.store = options.store;
    this.system = options.system;
    this.tenantId = options.tenantId;
    this.toolExecutionTimeoutMs =
      options.toolExecutionTimeoutMs ?? DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
    this.toolChoice = options.toolChoice;
    this.tools = options.tools ? cloneTools(options.tools) : undefined;
    this.updatedAt = this.createdAt;
  }

  get cost(): string {
    return formatCost(this.totalCostUSD);
  }

  get history(): CanonicalMessage[] {
    return cloneValue(this.messages);
  }

  get id(): string {
    return this.sessionId;
  }

  get totals(): {
    cachedTokens: number;
    cost: string;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
  } {
    return {
      cachedTokens: this.totalCachedTokens,
      cost: this.cost,
      costUSD: this.totalCostUSD,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
    };
  }

  /** Appends a user turn, executes the model/tool loop, and commits state. */
  async send(
    input: CanonicalMessage['content'],
    options: { signal?: AbortSignal } = {},
  ): Promise<CanonicalResponse> {
    const nextMessages = await this.prepareMessages(buildUserMessage(input));
    const result = await this.runCompleteToolLoop(nextMessages, options.signal);

    await this.finalizeExecution(result);
    return result.response;
  }

  /** Streams a user turn and commits state when the final `done` chunk arrives. */
  async *sendStream(
    input: CanonicalMessage['content'],
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamChunk, void, void> {
    const nextMessages = await this.prepareMessages(buildUserMessage(input));
    const result = yield* this.runStreamToolLoop(nextMessages, options.signal);
    await this.finalizeExecution(result);
  }

  /** Clears non-system history while preserving running totals. */
  clear(): void {
    this.messages = [];
    this.updatedAt = new Date().toISOString();
  }

  /** Serializes the conversation for storage or transport. */
  serialise(): ConversationSnapshot {
    return {
      ...(this.budgetUsd !== undefined ? { budgetUsd: this.budgetUsd } : {}),
      createdAt: this.createdAt,
      ...(this.maxToolRounds !== DEFAULT_MAX_TOOL_ROUNDS
        ? { maxToolRounds: this.maxToolRounds }
        : {}),
      ...(this.maxContextTokens !== undefined ? { maxContextTokens: this.maxContextTokens } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      messages: cloneValue(this.messages),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      sessionId: this.sessionId,
      ...(this.system !== undefined ? { system: this.system } : {}),
      ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      ...(this.toolExecutionTimeoutMs !== DEFAULT_TOOL_EXECUTION_TIMEOUT_MS
        ? { toolExecutionTimeoutMs: this.toolExecutionTimeoutMs }
        : {}),
      ...(this.toolChoice !== undefined ? { toolChoice: cloneValue(this.toolChoice) } : {}),
      ...(this.tools !== undefined ? { tools: cloneValue(this.tools) } : {}),
      totalCachedTokens: this.totalCachedTokens,
      totalCostUSD: this.totalCostUSD,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      updatedAt: this.updatedAt,
    };
  }

  /** Returns the full message list including the pinned system prompt. */
  toMessages(): CanonicalMessage[] {
    return this.system
      ? [{ content: this.system, pinned: true, role: 'system' }, ...cloneValue(this.messages)]
      : cloneValue(this.messages);
  }

  /** Exports the conversation as a markdown transcript. */
  toMarkdown(): string {
    const sections = [
      `# Conversation ${this.sessionId}`,
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Session ID | ${this.sessionId} |`,
      `| Created At | ${this.createdAt} |`,
      `| Updated At | ${this.updatedAt} |`,
      `| Total Cost | ${this.cost} |`,
      `| Input Tokens | ${this.totalInputTokens} |`,
      `| Output Tokens | ${this.totalOutputTokens} |`,
      `| Cached Tokens | ${this.totalCachedTokens} |`,
    ];

    if (this.model) {
      sections.push(`| Model | ${this.model} |`);
    }

    if (this.provider) {
      sections.push(`| Provider | ${this.provider} |`);
    }

    if (this.tenantId) {
      sections.push(`| Tenant ID | ${this.tenantId} |`);
    }

    for (const message of this.toMessages()) {
      sections.push('', `## ${capitaliseRole(message.role)}`, '', renderMessageMarkdown(message));
    }

    return sections.join('\n').trim();
  }

  /** Restores a conversation from a serialized snapshot. */
  static restore(
    client: ConversationClient,
    snapshot: ConversationSnapshot,
    options: Omit<ConversationOptions, 'messages'> = {},
  ): Conversation {
    const conversation = new Conversation(client, {
      ...options,
      ...(snapshot.budgetUsd !== undefined ? { budgetUsd: snapshot.budgetUsd } : {}),
      ...(options.maxToolRounds !== undefined
        ? { maxToolRounds: options.maxToolRounds }
        : snapshot.maxToolRounds !== undefined
          ? { maxToolRounds: snapshot.maxToolRounds }
          : {}),
      ...(snapshot.maxContextTokens !== undefined
        ? { maxContextTokens: snapshot.maxContextTokens }
        : {}),
      ...(snapshot.maxTokens !== undefined ? { maxTokens: snapshot.maxTokens } : {}),
      messages: snapshot.messages,
      ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      ...(snapshot.provider !== undefined ? { provider: snapshot.provider } : {}),
      sessionId: snapshot.sessionId,
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(snapshot.system !== undefined ? { system: snapshot.system } : {}),
      ...(snapshot.tenantId !== undefined ? { tenantId: snapshot.tenantId } : {}),
      ...(options.toolExecutionTimeoutMs !== undefined
        ? { toolExecutionTimeoutMs: options.toolExecutionTimeoutMs }
        : snapshot.toolExecutionTimeoutMs !== undefined
          ? { toolExecutionTimeoutMs: snapshot.toolExecutionTimeoutMs }
          : {}),
      ...(snapshot.toolChoice !== undefined ? { toolChoice: snapshot.toolChoice } : {}),
      ...(options.tools !== undefined
        ? { tools: options.tools }
        : snapshot.tools !== undefined
          ? { tools: snapshot.tools }
          : {}),
    });

    conversation.createdAt = snapshot.createdAt;
    conversation.totalCachedTokens = snapshot.totalCachedTokens;
    conversation.totalCostUSD = snapshot.totalCostUSD;
    conversation.totalInputTokens = snapshot.totalInputTokens;
    conversation.totalOutputTokens = snapshot.totalOutputTokens;
    conversation.updatedAt = snapshot.updatedAt;
    return conversation;
  }

  private applyUsage(usage: UsageMetrics): void {
    this.totalCachedTokens += usage.cachedTokens;
    this.totalCostUSD += usage.costUSD;
    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.updatedAt = new Date().toISOString();
  }

  private async prepareMessages(userMessage: CanonicalMessage): Promise<CanonicalMessage[]> {
    const nextMessages = [...this.messages, userMessage];
    if (!this.contextManager) {
      return nextMessages;
    }

    const context = this.buildContextManagerContext();
    if (!(await this.contextManager.shouldTrim(nextMessages, context))) {
      return nextMessages;
    }

    return this.contextManager.trim(nextMessages, context);
  }

  private async runCompleteToolLoop(
    initialMessages: CanonicalMessage[],
    signal: AbortSignal | undefined,
  ): Promise<{
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    response: CanonicalResponse;
    usage: UsageMetrics;
  }> {
    let workingMessages = [...initialMessages];
    let aggregateUsage = createEmptyUsage();
    let model = this.model;
    let provider = this.provider;
    let toolRounds = 0;

    while (true) {
      throwIfAborted(signal);
      const response = await this.client.complete(
        this.buildRequestOptions(
          workingMessages,
          signal,
          toolRounds,
          this.resolveRemainingBudgetUsd(aggregateUsage.costUSD),
        ),
      );
      model = response.model;
      provider = response.provider;
      aggregateUsage = accumulateUsage(aggregateUsage, response.usage);
      workingMessages = [...workingMessages, buildAssistantMessage(response)];

      if (!this.shouldContinueToolLoop(response.finishReason, response.toolCalls)) {
        return {
          messages: workingMessages,
          model,
          provider,
          response: {
            ...response,
            usage: aggregateUsage,
          },
          usage: aggregateUsage,
        };
      }

      toolRounds = this.assertNextToolRound(toolRounds + 1, model, provider);
      workingMessages = [
        ...workingMessages,
        await this.executeToolCalls(response.toolCalls, model, provider, signal),
      ];
    }
  }

  private async *runStreamToolLoop(
    initialMessages: CanonicalMessage[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<
    StreamChunk,
    {
      messages: CanonicalMessage[];
      model?: string;
      provider?: CanonicalProvider;
      usage: UsageMetrics;
    },
    void
  > {
    let workingMessages = [...initialMessages];
    let aggregateUsage = createEmptyUsage();
    let model = this.model;
    let provider = this.provider;
    let toolRounds = 0;

    while (true) {
      throwIfAborted(signal);
      const requestOptions = this.buildRequestOptions(
        workingMessages,
        signal,
        toolRounds,
        this.resolveRemainingBudgetUsd(aggregateUsage.costUSD),
      );
      model = requestOptions.model ?? model;
      provider = requestOptions.provider ?? provider;
      const pendingToolCalls = new Map<string, { args?: JsonObject; name: string }>();
      let text = '';
      let finishReason: CanonicalResponse['finishReason'] | undefined;
      let usage: UsageMetrics | undefined;

      for await (const chunk of this.client.stream(requestOptions)) {
        if (chunk.type === 'text-delta') {
          text += chunk.delta;
          yield chunk;
          continue;
        }

        if (chunk.type === 'tool-call-start') {
          pendingToolCalls.set(chunk.id, { name: chunk.name });
          yield chunk;
          continue;
        }

        if (chunk.type === 'tool-call-result') {
          const current = pendingToolCalls.get(chunk.id);
          pendingToolCalls.set(chunk.id, {
            args: isPlainJsonObject(chunk.result) ? chunk.result : { result: chunk.result },
            name: current?.name ?? chunk.name,
          });
          yield chunk;
          continue;
        }

        if (chunk.type === 'tool-call-delta') {
          yield chunk;
          continue;
        }

        if (chunk.type === 'error') {
          yield chunk;
          continue;
        }

        finishReason = chunk.finishReason;
        usage = chunk.usage;
      }

      if (!finishReason || !usage) {
        throw new ProviderError('Streaming conversation ended without a done chunk.');
      }

      aggregateUsage = accumulateUsage(aggregateUsage, usage);
      workingMessages = [
        ...workingMessages,
        buildAssistantStreamMessage(text, pendingToolCalls),
      ];

      const toolCalls = buildToolCallsFromPendingToolCalls(pendingToolCalls);
      if (!this.shouldContinueToolLoop(finishReason, toolCalls)) {
        yield {
          finishReason,
          type: 'done',
          usage: aggregateUsage,
        };
        return {
          messages: workingMessages,
          usage: aggregateUsage,
          ...(model !== undefined ? { model } : {}),
          ...(provider !== undefined ? { provider } : {}),
        };
      }

      toolRounds = this.assertNextToolRound(toolRounds + 1, model, provider);
      workingMessages = [
        ...workingMessages,
        await this.executeToolCalls(toolCalls, model, provider, signal),
      ];
    }
  }

  private shouldContinueToolLoop(
    finishReason: CanonicalResponse['finishReason'],
    toolCalls: CanonicalResponse['toolCalls'],
  ): boolean {
    return (
      finishReason === 'tool_call' &&
      toolCalls.length > 0 &&
      Boolean(this.tools?.some((tool) => typeof tool.execute === 'function'))
    );
  }

  private assertNextToolRound(
    nextRound: number,
    model: string | undefined,
    provider: CanonicalProvider | undefined,
  ): number {
    if (nextRound > this.maxToolRounds) {
      throw new MaxToolRoundsError(
        `Tool execution exceeded the max round limit of ${this.maxToolRounds}.`,
        {
          ...(model !== undefined ? { model } : {}),
          ...(provider !== undefined ? { provider } : {}),
        },
      );
    }

    return nextRound;
  }

  private async executeToolCalls(
    toolCalls: CanonicalResponse['toolCalls'],
    model: string | undefined,
    provider: CanonicalProvider | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CanonicalMessage> {
    const parts = await Promise.all(
      toolCalls.map((toolCall) => this.executeToolCall(toolCall, model, provider, signal)),
    );

    return {
      content: parts,
      role: 'user',
    };
  }

  private async executeToolCall(
    toolCall: CanonicalResponse['toolCalls'][number],
    model: string | undefined,
    provider: CanonicalProvider | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Extract<CanonicalPart, { type: 'tool_result' }>> {
    const tool = this.tools?.find((candidate) => candidate.name === toolCall.name);
    if (!tool?.execute) {
      return buildToolErrorPart(
        toolCall,
        new Error(`No executable tool registered for "${toolCall.name}".`),
      );
    }
    const execute = tool.execute;

    try {
      throwIfAborted(signal);
      const result = await executeToolWithGuards(
        () =>
          Promise.resolve(
            execute(toolCall.args, {
              ...(model !== undefined ? { model } : {}),
              ...(provider !== undefined ? { provider } : {}),
              sessionId: this.sessionId,
              ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
            }),
          ),
        this.toolExecutionTimeoutMs,
        signal,
      );

      return {
        isError: false,
        name: toolCall.name,
        result: normalizeToolResult(result),
        toolCallId: toolCall.id,
        type: 'tool_result',
      };
    } catch (error) {
      return buildToolErrorPart(toolCall, error);
    }
  }

  private async finalizeExecution(result: {
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    usage: UsageMetrics;
  }): Promise<void> {
    this.messages = result.messages;
    if (result.model !== undefined) {
      this.model = result.model;
    }
    if (result.provider !== undefined) {
      this.provider = result.provider;
    }
    this.applyUsage(result.usage);
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.store) {
      return;
    }

    const snapshot = this.serialise();
    await this.store.set(this.sessionId, snapshot, {
      createdAt: this.createdAt,
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
    });
  }

  private buildContextManagerContext(): {
    maxContextTokens?: number;
    model?: string;
    provider?: CanonicalProvider;
    system?: string;
  } {
    return {
      ...(this.maxContextTokens !== undefined
        ? { maxContextTokens: this.maxContextTokens }
        : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.system !== undefined ? { system: this.system } : {}),
    };
  }

  private buildRequestOptions(
    messages: CanonicalMessage[],
    signal: AbortSignal | undefined,
    toolRound: number = 0,
    budgetUsd: number | undefined = undefined,
  ): {
    budgetUsd?: number;
    maxTokens?: number;
    messages: CanonicalMessage[];
    model?: string;
    provider?: CanonicalProvider;
    sessionId?: string;
    signal?: AbortSignal;
    system?: string;
    tenantId?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
  } {
    const toolChoice = resolveToolChoiceForRound(this.toolChoice, toolRound);

    return {
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      messages,
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      sessionId: this.sessionId,
      ...(signal !== undefined ? { signal } : {}),
      ...(this.system !== undefined ? { system: this.system } : {}),
      ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(this.tools !== undefined ? { tools: this.tools } : {}),
    };
  }

  private resolveRemainingBudgetUsd(executionCostUSD: number): number | undefined {
    if (this.budgetUsd === undefined) {
      return undefined;
    }

    const remainingBudgetUsd = this.budgetUsd - (this.totalCostUSD + executionCostUSD);
    if (remainingBudgetUsd > 0) {
      return remainingBudgetUsd;
    }

    throw new BudgetExceededError(
      `Conversation budget of ${formatCost(this.budgetUsd)} has been exhausted.`,
      {
        details: {
          budgetUsd: this.budgetUsd,
          totalCostUSD: this.totalCostUSD + executionCostUSD,
        },
        ...(this.model !== undefined ? { model: this.model } : {}),
        ...(this.provider !== undefined ? { provider: this.provider } : {}),
      },
    );
  }
}

function buildUserMessage(input: CanonicalMessage['content']): CanonicalMessage {
  return {
    content: typeof input === 'string' ? input : cloneValue(input),
    role: 'user',
  };
}

function resolveToolChoiceForRound(
  toolChoice: CanonicalToolChoice | undefined,
  toolRound: number,
): CanonicalToolChoice | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (toolRound === 0) {
    return toolChoice;
  }

  if (toolChoice.type === 'tool' || toolChoice.type === 'any') {
    return { type: 'auto' };
  }

  return toolChoice;
}

function buildAssistantMessage(response: CanonicalResponse): CanonicalMessage {
  if (response.content.length === 0) {
    return {
      content: response.text,
      role: 'assistant',
    };
  }

  if (
    response.content.length === 1 &&
    response.content[0]?.type === 'text' &&
    response.toolCalls.length === 0
  ) {
    return {
      content: response.text,
      role: 'assistant',
    };
  }

  return {
    content: cloneValue(response.content),
    role: 'assistant',
  };
}

function buildAssistantStreamMessage(
  text: string,
  pendingToolCalls: Map<string, { args?: JsonObject; name: string }>,
): CanonicalMessage {
  const content: CanonicalPart[] = [];
  if (text.length > 0) {
    content.push({
      text,
      type: 'text',
    });
  }

  for (const [id, toolCall] of pendingToolCalls.entries()) {
    content.push({
      args: toolCall.args ?? {},
      id,
      name: toolCall.name,
      type: 'tool_call',
    });
  }

  if (content.length === 0) {
    return {
      content: '',
      role: 'assistant',
    };
  }

  if (content.length === 1 && content[0]?.type === 'text') {
    return {
      content: content[0].text,
      role: 'assistant',
    };
  }

  return {
    content,
    role: 'assistant',
  };
}

function buildToolCallsFromPendingToolCalls(
  pendingToolCalls: Map<string, { args?: JsonObject; name: string }>,
): CanonicalResponse['toolCalls'] {
  return [...pendingToolCalls.entries()].map(([id, toolCall]) => ({
    args: toolCall.args ?? {},
    id,
    name: toolCall.name,
  }));
}

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isPlainJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function cloneTools(tools: CanonicalTool[]): CanonicalTool[] {
  return tools.map((tool) => ({
    ...tool,
    parameters: cloneValue(tool.parameters),
  }));
}

function createEmptyUsage(): UsageMetrics {
  return {
    cachedTokens: 0,
    cost: '$0.00',
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function accumulateUsage(total: UsageMetrics, next: UsageMetrics): UsageMetrics {
  const costUSD = total.costUSD + next.costUSD;
  const cachedReadTokens = sumOptionalMetric(total.cachedReadTokens, next.cachedReadTokens);
  const cachedWriteTokens = sumOptionalMetric(total.cachedWriteTokens, next.cachedWriteTokens);

  return {
    cachedTokens: total.cachedTokens + next.cachedTokens,
    cost: formatCost(costUSD),
    costUSD,
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
  };
}

function capitaliseRole(role: CanonicalMessage['role']): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function renderMessageMarkdown(message: CanonicalMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content.map(renderPartMarkdown).join('\n\n');
}

function renderPartMarkdown(part: CanonicalPart): string {
  switch (part.type) {
    case 'audio':
      return `Audio: ${part.url ?? '[embedded audio]'}`;
    case 'document':
      return `Document: ${part.title ?? part.url ?? '[embedded document]'}`;
    case 'image_base64':
      return `Image (base64, ${part.mediaType})`;
    case 'image_url':
      return `Image: ${part.url}`;
    case 'text':
      return part.text;
    case 'tool_call':
      return [
        `Tool Call: \`${part.name}\``,
        '```json',
        JSON.stringify(
          {
            args: part.args,
            id: part.id,
          },
          null,
          2,
        ),
        '```',
      ].join('\n');
    case 'tool_result':
      return [
        `Tool Result: \`${part.name ?? part.toolCallId}\``,
        '```json',
        JSON.stringify(
          {
            isError: part.isError ?? false,
            result: part.result,
            toolCallId: part.toolCallId,
          },
          null,
          2,
        ),
        '```',
      ].join('\n');
  }
}

function sumOptionalMetric(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  return (left ?? 0) + (right ?? 0);
}

function buildToolErrorPart(
  toolCall: CanonicalResponse['toolCalls'][number],
  error: unknown,
): Extract<CanonicalPart, { type: 'tool_result' }> {
  return {
    isError: true,
    name: toolCall.name,
    result: {
      error: serializeToolError(error),
    },
    toolCallId: toolCall.id,
    type: 'tool_result',
  };
}

function serializeToolError(error: unknown): JsonValue {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  if (typeof error === 'string') {
    return {
      message: error,
      name: 'Error',
    };
  }

  return {
    message: 'Unknown tool execution error.',
    name: 'Error',
  };
}

function normalizeToolResult(result: JsonValue | undefined): JsonValue {
  return cloneValue(result ?? null);
}

async function executeToolWithGuards(
  execute: () => Promise<JsonValue>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<JsonValue> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const guardedPromises: Promise<JsonValue>[] = [Promise.resolve().then(execute)];

  guardedPromises.push(
    new Promise<JsonValue>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }),
  );

  if (signal) {
    guardedPromises.push(
      new Promise<JsonValue>((_, reject) => {
        if (signal.aborted) {
          reject(buildAbortError(signal.reason));
          return;
        }

        const onAbort = () => {
          reject(buildAbortError(signal.reason));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }),
    );
  }

  try {
    return await Promise.race(guardedPromises);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    removeAbortListener?.();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw buildAbortError(signal.reason);
}

function buildAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
