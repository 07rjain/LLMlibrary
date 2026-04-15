import type { CanonicalProvider } from './types.js';

/** Metadata attached to typed LLM errors. */
export interface LLMErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
  model?: string;
  provider?: CanonicalProvider;
  requestId?: string;
  retryable?: boolean;
  statusCode?: number;
}

/** Base error for provider, capability, budget, and transport failures. */
export class LLMError extends Error {
  readonly cause: unknown;
  readonly details: Record<string, unknown> | undefined;
  readonly model: string | undefined;
  readonly provider: CanonicalProvider | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.cause = options.cause;
    this.details = options.details;
    this.model = options.model;
    this.provider = options.provider;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      cause: this.cause,
      details: this.details,
      message: this.message,
      model: this.model,
      name: this.name,
      provider: this.provider,
      requestId: this.requestId,
      retryable: this.retryable,
      statusCode: this.statusCode,
    };
  }
}

/** Authentication or authorization failure reported by a provider. */
export class AuthenticationError extends LLMError {}

/** Rate-limit or quota exhaustion failure. */
export class RateLimitError extends LLMError {}

/** Context-window or token-limit failure. */
export class ContextLimitError extends LLMError {}

/** Unsupported provider, model, or feature combination. */
export class ProviderCapabilityError extends LLMError {}

/** Budget guard failure raised before or during a request. */
export class BudgetExceededError extends LLMError {}

/** Tool loop exceeded the configured maximum number of rounds. */
export class MaxToolRoundsError extends LLMError {}

/** Generic provider-side failure that does not fit a narrower subtype. */
export class ProviderError extends LLMError {}
