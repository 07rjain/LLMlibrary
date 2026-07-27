import { estimateMessageTokens } from './utils/token-estimator.js';
/**
 * Drops the oldest removable messages when message-count or token estimates
 * exceed the configured budget.
 *
 * @example
 * ```ts
 * const strategy = new SlidingWindowStrategy({
 *   maxMessages: 12,
 *   maxTokens: 16_000,
 * });
 * ```
 */
export class SlidingWindowStrategy {
    maxMessages;
    maxTokens;
    onTrim;
    tokenEstimator;
    constructor(options = {}) {
        this.maxMessages = options.maxMessages;
        this.maxTokens = options.maxTokens;
        this.onTrim = options.onTrim;
        this.tokenEstimator = options.tokenEstimator ?? estimateMessageTokens;
    }
    shouldTrim(messages, context) {
        if (this.maxMessages !== undefined && messages.length > this.maxMessages) {
            return true;
        }
        const maxTokens = this.resolveMaxTokens(context);
        if (maxTokens === undefined) {
            return false;
        }
        return this.estimateTokens(messages, context.system) > maxTokens;
    }
    trim(messages, context) {
        const working = [...messages];
        const beforeCount = working.length;
        const maxTokens = this.resolveMaxTokens(context);
        while (this.exceedsMessageLimit(working) ||
            (maxTokens !== undefined && this.estimateTokens(working, context.system) > maxTokens)) {
            const removableGroup = findOldestRemovableMessageGroup(working);
            if (!removableGroup) {
                break;
            }
            working.splice(removableGroup[0], removableGroup.length);
        }
        if (working.length !== beforeCount) {
            this.onTrim?.({
                afterCount: working.length,
                beforeCount,
                estimatedTokens: this.estimateTokens(working, context.system),
                removedCount: beforeCount - working.length,
            });
        }
        return working;
    }
    estimateTokens(messages, system) {
        const effectiveMessages = system
            ? [{ content: system, pinned: true, role: 'system' }, ...messages]
            : messages;
        return this.tokenEstimator(effectiveMessages);
    }
    resolveMaxTokens(context) {
        const configuredLimit = context.maxContextTokens ?? this.maxTokens;
        const modelLimit = context.contextWindow !== undefined
            ? Math.max(1, context.contextWindow -
                (context.reservedOutputTokens ?? 0) -
                (context.estimatedToolSchemaTokens ?? 0))
            : undefined;
        if (configuredLimit === undefined) {
            return modelLimit;
        }
        if (modelLimit === undefined) {
            return configuredLimit;
        }
        return Math.min(configuredLimit, modelLimit);
    }
    exceedsMessageLimit(messages) {
        return this.maxMessages !== undefined && messages.length > this.maxMessages;
    }
}
/**
 * Replaces older removable history with a summary message before falling back to
 * sliding-window trimming.
 *
 * @example
 * ```ts
 * const strategy = new SummarisationStrategy({
 *   maxMessages: 10,
 *   keepLastMessages: 2,
 *   summarizer: async (messages) => `Summary of ${messages.length} messages`,
 * });
 * ```
 */
export class SummarisationStrategy {
    baseStrategy;
    keepLastMessages;
    summarizer;
    summaryMetadata;
    constructor(options) {
        this.baseStrategy = new SlidingWindowStrategy(options);
        this.keepLastMessages = Math.max(0, options.keepLastMessages ?? 2);
        this.summarizer = options.summarizer;
        this.summaryMetadata = options.summaryMetadata;
    }
    shouldTrim(messages, context) {
        return this.baseStrategy.shouldTrim(messages, context);
    }
    async trim(messages, context) {
        if (!this.baseStrategy.shouldTrim(messages, context)) {
            return [...messages];
        }
        const removableGroups = findRemovableMessageGroups(messages);
        const summaryTargetCount = removableGroups.length - this.keepLastMessages;
        if (summaryTargetCount < 2) {
            return this.baseStrategy.trim(messages, context);
        }
        const groupsToSummarize = removableGroups.slice(0, summaryTargetCount);
        const indexesToSummarize = groupsToSummarize.flat();
        const messagesToSummarize = indexesToSummarize.map((index) => cloneMessage(messages[index]));
        const summary = (await this.summarizer(messagesToSummarize, context)).trim();
        if (summary.length === 0) {
            return this.baseStrategy.trim(messages, context);
        }
        const selected = new Set(indexesToSummarize);
        const firstIndex = indexesToSummarize[0];
        const insertionIndex = messages
            .slice(0, firstIndex)
            .filter((_, index) => !selected.has(index)).length;
        const trimmed = messages.filter((_, index) => !selected.has(index));
        trimmed.splice(insertionIndex, 0, buildSummaryMessage(summary, messagesToSummarize, this.summaryMetadata));
        if (!this.baseStrategy.shouldTrim(trimmed, context)) {
            return trimmed;
        }
        return this.baseStrategy.trim(trimmed, context);
    }
}
function findOldestRemovableMessageGroup(messages) {
    return findRemovableMessageGroups(messages)[0];
}
function findRemovableMessageGroups(messages) {
    const latestUserIndex = findLatestUserIndex(messages);
    const removableGroups = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || message.pinned) {
            continue;
        }
        if (index === latestUserIndex) {
            continue;
        }
        const next = messages[index + 1];
        if (hasToolCallPart(message) &&
            next &&
            next.role === 'user' &&
            hasToolResultPart(next) &&
            !next.pinned) {
            if (index + 1 === latestUserIndex) {
                continue;
            }
            removableGroups.push([index, index + 1]);
            index += 1;
            continue;
        }
        if (hasToolCallPart(message) || hasToolResultPart(message)) {
            continue;
        }
        removableGroups.push([index]);
    }
    return removableGroups;
}
function hasToolCallPart(message) {
    return Array.isArray(message.content)
        ? message.content.some((part) => part.type === 'tool_call')
        : false;
}
function hasToolResultPart(message) {
    return Array.isArray(message.content)
        ? message.content.some((part) => part.type === 'tool_result')
        : false;
}
function findLatestUserIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
            return index;
        }
    }
    return -1;
}
function buildSummaryMessage(summary, messages, metadata) {
    return {
        content: summary,
        metadata: {
            ...(metadata ?? {}),
            summarizedMessageCount: messages.length,
            summary: true,
        },
        role: 'assistant',
    };
}
function cloneMessage(message) {
    return JSON.parse(JSON.stringify(message));
}
