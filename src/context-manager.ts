import { estimateMessageTokens } from './utils/token-estimator.js';

import type { CanonicalMessage, CanonicalProvider } from './types.js';

type MaybePromise<TValue> = Promise<TValue> | TValue;

/** Metadata passed to context trimming strategies before a model call. */
export interface ContextManagerContext {
  maxContextTokens?: number;
  model?: string;
  provider?: CanonicalProvider;
  system?: string;
}

/** Contract for pluggable context trimming strategies. */
export interface ContextManager {
  shouldTrim(
    messages: CanonicalMessage[],
    context: ContextManagerContext,
  ): MaybePromise<boolean>;
  trim(
    messages: CanonicalMessage[],
    context: ContextManagerContext,
  ): MaybePromise<CanonicalMessage[]>;
}

/** Configuration for the sliding-window trimming strategy. */
export interface SlidingWindowStrategyOptions {
  maxMessages?: number;
  maxTokens?: number;
  onTrim?: (event: {
    afterCount: number;
    beforeCount: number;
    estimatedTokens: number;
    removedCount: number;
  }) => void;
  tokenEstimator?: (messages: CanonicalMessage[]) => number;
}

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
export class SlidingWindowStrategy implements ContextManager {
  private readonly maxMessages: number | undefined;
  private readonly maxTokens: number | undefined;
  private readonly onTrim:
    | ((event: {
        afterCount: number;
        beforeCount: number;
        estimatedTokens: number;
        removedCount: number;
      }) => void)
    | undefined;
  private readonly tokenEstimator: (messages: CanonicalMessage[]) => number;

  constructor(options: SlidingWindowStrategyOptions = {}) {
    this.maxMessages = options.maxMessages;
    this.maxTokens = options.maxTokens;
    this.onTrim = options.onTrim;
    this.tokenEstimator = options.tokenEstimator ?? estimateMessageTokens;
  }

  shouldTrim(messages: CanonicalMessage[], context: ContextManagerContext): boolean {
    if (this.maxMessages !== undefined && messages.length > this.maxMessages) {
      return true;
    }

    const maxTokens = context.maxContextTokens ?? this.maxTokens;
    if (maxTokens === undefined) {
      return false;
    }

    return this.estimateTokens(messages, context.system) > maxTokens;
  }

  trim(messages: CanonicalMessage[], context: ContextManagerContext): CanonicalMessage[] {
    const working = [...messages];
    const beforeCount = working.length;
    const maxTokens = context.maxContextTokens ?? this.maxTokens;

    while (
      this.exceedsMessageLimit(working) ||
      (maxTokens !== undefined && this.estimateTokens(working, context.system) > maxTokens)
    ) {
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

  private estimateTokens(messages: CanonicalMessage[], system: string | undefined): number {
    const effectiveMessages: CanonicalMessage[] = system
      ? [{ content: system, pinned: true, role: 'system' }, ...messages]
      : messages;

    return this.tokenEstimator(effectiveMessages);
  }

  private exceedsMessageLimit(messages: CanonicalMessage[]): boolean {
    return this.maxMessages !== undefined && messages.length > this.maxMessages;
  }
}

export interface SummarisationStrategyOptions extends SlidingWindowStrategyOptions {
  keepLastMessages?: number;
  summarizer: (
    messages: CanonicalMessage[],
    context: ContextManagerContext,
  ) => MaybePromise<string>;
  summaryMetadata?: Record<string, unknown>;
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
export class SummarisationStrategy implements ContextManager {
  private readonly baseStrategy: SlidingWindowStrategy;
  private readonly keepLastMessages: number;
  private readonly summarizer: SummarisationStrategyOptions['summarizer'];
  private readonly summaryMetadata: Record<string, unknown> | undefined;

  constructor(options: SummarisationStrategyOptions) {
    this.baseStrategy = new SlidingWindowStrategy(options);
    this.keepLastMessages = Math.max(0, options.keepLastMessages ?? 2);
    this.summarizer = options.summarizer;
    this.summaryMetadata = options.summaryMetadata;
  }

  shouldTrim(messages: CanonicalMessage[], context: ContextManagerContext): boolean {
    return this.baseStrategy.shouldTrim(messages, context);
  }

  async trim(
    messages: CanonicalMessage[],
    context: ContextManagerContext,
  ): Promise<CanonicalMessage[]> {
    if (!this.baseStrategy.shouldTrim(messages, context)) {
      return [...messages];
    }

    const removableIndexes = findRemovableMessageIndexes(messages);
    const summaryTargetCount = removableIndexes.length - this.keepLastMessages;

    if (summaryTargetCount < 2) {
      return this.baseStrategy.trim(messages, context);
    }

    const indexesToSummarize = removableIndexes.slice(0, summaryTargetCount);
    const messagesToSummarize = indexesToSummarize.map((index) => cloneMessage(messages[index]!));
    const summary = (await this.summarizer(messagesToSummarize, context)).trim();

    if (summary.length === 0) {
      return this.baseStrategy.trim(messages, context);
    }

    const trimmed = [...messages];
    const firstIndex = indexesToSummarize[0]!;
    trimmed.splice(
      firstIndex,
      indexesToSummarize.length,
      buildSummaryMessage(summary, messagesToSummarize, this.summaryMetadata),
    );

    if (!this.baseStrategy.shouldTrim(trimmed, context)) {
      return trimmed;
    }

    return this.baseStrategy.trim(trimmed, context);
  }
}

function findOldestRemovableMessageIndex(messages: CanonicalMessage[]): number {
  const removableIndexes = findRemovableMessageIndexes(messages);
  return removableIndexes[0] ?? -1;
}

function findRemovableMessageIndexes(messages: CanonicalMessage[]): number[] {
  const latestUserIndex = findLatestUserIndex(messages);
  const removableIndexes: number[] = [];

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

function findLatestUserIndex(messages: CanonicalMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }

  return -1;
}

function buildSummaryMessage(
  summary: string,
  messages: CanonicalMessage[],
  metadata: Record<string, unknown> | undefined,
): CanonicalMessage {
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

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return JSON.parse(JSON.stringify(message)) as CanonicalMessage;
}
