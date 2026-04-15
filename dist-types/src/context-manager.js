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
        const maxTokens = context.maxContextTokens ?? this.maxTokens;
        if (maxTokens === undefined) {
            return false;
        }
        return this.estimateTokens(messages, context.system) > maxTokens;
    }
    trim(messages, context) {
        const working = [...messages];
        const beforeCount = working.length;
        const maxTokens = context.maxContextTokens ?? this.maxTokens;
        while (this.exceedsMessageLimit(working) ||
            (maxTokens !== undefined && this.estimateTokens(working, context.system) > maxTokens)) {
            const removableIndex = findOldestRemovableMessageIndex(working);
            if (removableIndex === -1) {
                break;
            }
            working.splice(removableIndex, 1);
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
        const removableIndexes = findRemovableMessageIndexes(messages);
        const summaryTargetCount = removableIndexes.length - this.keepLastMessages;
        if (summaryTargetCount < 2) {
            return this.baseStrategy.trim(messages, context);
        }
        const indexesToSummarize = removableIndexes.slice(0, summaryTargetCount);
        const messagesToSummarize = indexesToSummarize.map((index) => cloneMessage(messages[index]));
        const summary = (await this.summarizer(messagesToSummarize, context)).trim();
        if (summary.length === 0) {
            return this.baseStrategy.trim(messages, context);
        }
        const trimmed = [...messages];
        const firstIndex = indexesToSummarize[0];
        trimmed.splice(firstIndex, indexesToSummarize.length, buildSummaryMessage(summary, messagesToSummarize, this.summaryMetadata));
        if (!this.baseStrategy.shouldTrim(trimmed, context)) {
            return trimmed;
        }
        return this.baseStrategy.trim(trimmed, context);
    }
}
function findOldestRemovableMessageIndex(messages) {
    const removableIndexes = findRemovableMessageIndexes(messages);
    return removableIndexes[0] ?? -1;
}
function findRemovableMessageIndexes(messages) {
    const latestUserIndex = findLatestUserIndex(messages);
    const removableIndexes = [];
    for (let index = 0; index < messages.length; index += 1) {
        if (messages[index]?.pinned) {
            continue;
        }
        if (index === latestUserIndex) {
            continue;
        }
        removableIndexes.push(index);
    }
    return removableIndexes;
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
