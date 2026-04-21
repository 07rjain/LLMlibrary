import { BudgetExceededError, MaxToolRoundsError, ProviderError } from './errors.js';
import { buildAbortError, createCancelableStream, throwIfAborted, } from './stream-control.js';
import { formatCost } from './utils/cost.js';
const DEFAULT_MAX_TOOL_ROUNDS = 5;
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 30_000;
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
    budgetExceededAction;
    client;
    contextManager;
    createdAt;
    budgetUsd;
    maxToolRounds;
    maxContextTokens;
    maxTokens;
    messages;
    model;
    provider;
    providerOptions;
    sessionId;
    store;
    system;
    tenantId;
    toolExecutionTimeoutMs;
    toolChoice;
    tools;
    onWarning;
    totalCachedTokens = 0;
    totalCostUSD = 0;
    totalInputTokens = 0;
    totalOutputTokens = 0;
    updatedAt;
    constructor(client, options = {}) {
        this.budgetExceededAction = options.budgetExceededAction ?? 'throw';
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
        this.providerOptions = options.providerOptions ? cloneValue(options.providerOptions) : undefined;
        this.sessionId = options.sessionId ?? generateSessionId();
        this.store = options.store;
        this.system = options.system;
        this.tenantId = options.tenantId;
        this.toolExecutionTimeoutMs =
            options.toolExecutionTimeoutMs ?? DEFAULT_TOOL_EXECUTION_TIMEOUT_MS;
        this.toolChoice = options.toolChoice;
        this.tools = options.tools ? cloneTools(options.tools) : undefined;
        this.onWarning = options.onWarning ?? ((message) => console.warn(message));
        this.updatedAt = this.createdAt;
    }
    get cost() {
        return formatCost(this.totalCostUSD);
    }
    get history() {
        return cloneValue(this.messages);
    }
    get id() {
        return this.sessionId;
    }
    get totals() {
        return {
            cachedTokens: this.totalCachedTokens,
            cost: this.cost,
            costUSD: this.totalCostUSD,
            inputTokens: this.totalInputTokens,
            outputTokens: this.totalOutputTokens,
        };
    }
    /** Appends a user turn, executes the model/tool loop, and commits state. */
    async send(input, options = {}) {
        const nextMessages = await this.prepareMessages(buildUserMessage(input));
        const result = await this.runCompleteToolLoop(nextMessages, options.signal);
        await this.finalizeExecution(result);
        return result.response;
    }
    /** Streams a user turn and commits state when the final `done` chunk arrives. */
    sendStream(input, options = {}) {
        return createCancelableStream(async function* (signal) {
            const nextMessages = await this.prepareMessages(buildUserMessage(input));
            const result = yield* this.runStreamToolLoop(nextMessages, signal);
            await this.finalizeExecution(result);
        }.bind(this), options.signal);
    }
    /** Clears non-system history while preserving running totals. */
    clear() {
        this.messages = [];
        this.updatedAt = new Date().toISOString();
    }
    /** Serializes the conversation for storage or transport. */
    serialise() {
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
            ...(this.providerOptions !== undefined
                ? { providerOptions: cloneValue(this.providerOptions) }
                : {}),
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
    toMessages() {
        return this.system
            ? [{ content: this.system, pinned: true, role: 'system' }, ...cloneValue(this.messages)]
            : cloneValue(this.messages);
    }
    /** Exports the conversation as a markdown transcript. */
    toMarkdown() {
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
    static restore(client, snapshot, options = {}) {
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
            ...(snapshot.providerOptions !== undefined
                ? { providerOptions: snapshot.providerOptions }
                : {}),
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
    applyUsage(usage) {
        this.totalCachedTokens += usage.cachedTokens;
        this.totalCostUSD += usage.costUSD;
        this.totalInputTokens += usage.inputTokens;
        this.totalOutputTokens += usage.outputTokens;
        this.updatedAt = new Date().toISOString();
    }
    async prepareMessages(userMessage) {
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
    async runCompleteToolLoop(initialMessages, signal) {
        let workingMessages = [...initialMessages];
        let aggregateUsage = createEmptyUsage();
        let model = this.model;
        let provider = this.provider;
        let toolRounds = 0;
        while (true) {
            throwIfAborted(signal);
            const remainingBudget = this.resolveRemainingBudgetDecision(aggregateUsage.costUSD);
            if (remainingBudget.action === 'skip') {
                const response = buildBudgetSkipResponse(remainingBudget.error, model, provider);
                aggregateUsage = accumulateUsage(aggregateUsage, response.usage);
                workingMessages = [...workingMessages, buildAssistantMessage(response)];
                return {
                    messages: workingMessages,
                    model: response.model,
                    provider: response.provider,
                    response: {
                        ...response,
                        usage: aggregateUsage,
                    },
                    usage: aggregateUsage,
                };
            }
            const response = await this.client.complete(this.buildRequestOptions(workingMessages, signal, toolRounds, remainingBudget.budgetUsd));
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
    async *runStreamToolLoop(initialMessages, signal) {
        let workingMessages = [...initialMessages];
        let aggregateUsage = createEmptyUsage();
        let model = this.model;
        let provider = this.provider;
        let toolRounds = 0;
        while (true) {
            throwIfAborted(signal);
            const remainingBudget = this.resolveRemainingBudgetDecision(aggregateUsage.costUSD);
            if (remainingBudget.action === 'skip') {
                const response = buildBudgetSkipResponse(remainingBudget.error, model, provider);
                aggregateUsage = accumulateUsage(aggregateUsage, response.usage);
                workingMessages = [...workingMessages, buildAssistantMessage(response)];
                yield { delta: response.text, type: 'text-delta' };
                yield {
                    finishReason: response.finishReason,
                    type: 'done',
                    usage: aggregateUsage,
                };
                return {
                    messages: workingMessages,
                    model: response.model,
                    provider: response.provider,
                    usage: aggregateUsage,
                };
            }
            const requestOptions = this.buildRequestOptions(workingMessages, signal, toolRounds, remainingBudget.budgetUsd);
            model = requestOptions.model ?? model;
            provider = requestOptions.provider ?? provider;
            const pendingToolCalls = new Map();
            let text = '';
            let finishReason;
            let usage;
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
    shouldContinueToolLoop(finishReason, toolCalls) {
        return (finishReason === 'tool_call' &&
            toolCalls.length > 0 &&
            Boolean(this.tools?.some((tool) => typeof tool.execute === 'function')));
    }
    assertNextToolRound(nextRound, model, provider) {
        if (nextRound > this.maxToolRounds) {
            throw new MaxToolRoundsError(`Tool execution exceeded the max round limit of ${this.maxToolRounds}.`, {
                ...(model !== undefined ? { model } : {}),
                ...(provider !== undefined ? { provider } : {}),
            });
        }
        return nextRound;
    }
    async executeToolCalls(toolCalls, model, provider, signal) {
        const parts = await Promise.all(toolCalls.map((toolCall) => this.executeToolCall(toolCall, model, provider, signal)));
        return {
            content: parts,
            role: 'user',
        };
    }
    async executeToolCall(toolCall, model, provider, signal) {
        const tool = this.tools?.find((candidate) => candidate.name === toolCall.name);
        if (!tool?.execute) {
            return buildToolErrorPart(toolCall, new Error(`No executable tool registered for "${toolCall.name}".`));
        }
        const execute = tool.execute;
        try {
            throwIfAborted(signal);
            const result = await executeToolWithGuards(() => Promise.resolve(execute(toolCall.args, {
                ...(model !== undefined ? { model } : {}),
                ...(provider !== undefined ? { provider } : {}),
                sessionId: this.sessionId,
                ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
            })), this.toolExecutionTimeoutMs, signal);
            return {
                isError: false,
                name: toolCall.name,
                result: normalizeToolResult(result),
                toolCallId: toolCall.id,
                type: 'tool_result',
            };
        }
        catch (error) {
            return buildToolErrorPart(toolCall, error);
        }
    }
    async finalizeExecution(result) {
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
    async persist() {
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
    buildContextManagerContext() {
        return {
            ...(this.maxContextTokens !== undefined
                ? { maxContextTokens: this.maxContextTokens }
                : {}),
            ...(this.model !== undefined ? { model: this.model } : {}),
            ...(this.provider !== undefined ? { provider: this.provider } : {}),
            ...(this.system !== undefined ? { system: this.system } : {}),
        };
    }
    buildRequestOptions(messages, signal, toolRound = 0, budgetUsd = undefined) {
        const toolChoice = resolveToolChoiceForRound(this.toolChoice, toolRound);
        return {
            budgetExceededAction: this.budgetExceededAction,
            ...(budgetUsd !== undefined ? { budgetUsd } : {}),
            messages,
            ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
            ...(this.model !== undefined ? { model: this.model } : {}),
            ...(this.provider !== undefined ? { provider: this.provider } : {}),
            ...(this.providerOptions !== undefined ? { providerOptions: this.providerOptions } : {}),
            sessionId: this.sessionId,
            ...(signal !== undefined ? { signal } : {}),
            ...(this.system !== undefined ? { system: this.system } : {}),
            ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
            ...(toolChoice !== undefined ? { toolChoice } : {}),
            ...(this.tools !== undefined ? { tools: this.tools } : {}),
        };
    }
    resolveRemainingBudgetDecision(executionCostUSD) {
        if (this.budgetUsd === undefined) {
            return {
                action: 'continue',
                budgetUsd: undefined,
            };
        }
        const remainingBudgetUsd = this.budgetUsd - (this.totalCostUSD + executionCostUSD);
        if (remainingBudgetUsd > 0) {
            return {
                action: 'continue',
                budgetUsd: remainingBudgetUsd,
            };
        }
        const error = new BudgetExceededError(`Conversation budget of ${formatCost(this.budgetUsd)} has been exhausted.`, {
            details: {
                budgetUsd: this.budgetUsd,
                totalCostUSD: this.totalCostUSD + executionCostUSD,
            },
            ...(this.model !== undefined ? { model: this.model } : {}),
            ...(this.provider !== undefined ? { provider: this.provider } : {}),
        });
        if (this.budgetExceededAction === 'warn') {
            this.onWarning(error.message);
            return {
                action: 'continue',
                budgetUsd: undefined,
            };
        }
        if (this.budgetExceededAction === 'skip') {
            return {
                action: 'skip',
                error,
            };
        }
        throw error;
    }
}
function buildUserMessage(input) {
    return {
        content: typeof input === 'string' ? input : cloneValue(input),
        role: 'user',
    };
}
function resolveToolChoiceForRound(toolChoice, toolRound) {
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
function buildAssistantMessage(response) {
    if (response.content.length === 0) {
        return {
            content: response.text,
            role: 'assistant',
        };
    }
    if (response.content.length === 1 &&
        response.content[0]?.type === 'text' &&
        response.toolCalls.length === 0) {
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
function buildAssistantStreamMessage(text, pendingToolCalls) {
    const content = [];
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
function buildToolCallsFromPendingToolCalls(pendingToolCalls) {
    return [...pendingToolCalls.entries()].map(([id, toolCall]) => ({
        args: toolCall.args ?? {},
        id,
        name: toolCall.name,
    }));
}
function generateSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function isPlainJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
}
function cloneTools(tools) {
    return tools.map((tool) => ({
        ...tool,
        parameters: cloneValue(tool.parameters),
    }));
}
function createEmptyUsage() {
    return {
        cachedTokens: 0,
        cost: '$0.00',
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
    };
}
function buildBudgetSkipResponse(error, model, provider) {
    return {
        content: [{ text: error.message, type: 'text' }],
        finishReason: 'error',
        model: model ?? 'budget-skip',
        provider: provider ?? 'mock',
        raw: {
            reason: 'budget_exceeded',
            skipped: true,
            ...(error.details ? { details: error.details } : {}),
        },
        text: error.message,
        toolCalls: [],
        usage: createEmptyUsage(),
    };
}
function accumulateUsage(total, next) {
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
function capitaliseRole(role) {
    return role.slice(0, 1).toUpperCase() + role.slice(1);
}
function renderMessageMarkdown(message) {
    if (typeof message.content === 'string') {
        return message.content;
    }
    return message.content.map(renderPartMarkdown).join('\n\n');
}
function renderPartMarkdown(part) {
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
                JSON.stringify({
                    args: part.args,
                    id: part.id,
                }, null, 2),
                '```',
            ].join('\n');
        case 'tool_result':
            return [
                `Tool Result: \`${part.name ?? part.toolCallId}\``,
                '```json',
                JSON.stringify({
                    isError: part.isError ?? false,
                    result: part.result,
                    toolCallId: part.toolCallId,
                }, null, 2),
                '```',
            ].join('\n');
    }
}
function sumOptionalMetric(left, right) {
    if (left === undefined && right === undefined) {
        return undefined;
    }
    return (left ?? 0) + (right ?? 0);
}
function buildToolErrorPart(toolCall, error) {
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
function serializeToolError(error) {
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
function normalizeToolResult(result) {
    return cloneValue(result ?? null);
}
async function executeToolWithGuards(execute, timeoutMs, signal) {
    let timeoutId;
    let removeAbortListener;
    const guardedPromises = [Promise.resolve().then(execute)];
    guardedPromises.push(new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
    }));
    if (signal) {
        guardedPromises.push(new Promise((_, reject) => {
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
        }));
    }
    try {
        return await Promise.race(guardedPromises);
    }
    finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        removeAbortListener?.();
    }
}
