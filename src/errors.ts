import { sanitizeForLogging } from './redaction.js';

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
      cause: sanitizeForLogging(this.cause),
      details: sanitizeForLogging(this.details),
      message: sanitizeForLogging(this.message),
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

/** A persisted conversation snapshot failed fail-closed validation. */
export class InvalidConversationSnapshotError extends LLMError {
  constructor(path: string, constraint: string) {
    const safePath = sanitizeSnapshotErrorField(path, 'snapshot');
    const safeConstraint = sanitizeSnapshotErrorField(
      constraint,
      'invalid_value',
    );
    super('Conversation snapshot is invalid.', {
      details: {
        code: 'invalid_conversation_snapshot',
        constraint: safeConstraint,
        path: safePath,
      },
      retryable: false,
      statusCode: 400,
    });
  }
}

/** A deterministic mock operation was invoked without a queued result. */
export class MockQueueExhaustedError extends LLMError {
  constructor(
    operation: 'complete' | 'embed' | 'speak' | 'stream' | 'transcribe',
    options: Pick<LLMErrorOptions, 'model' | 'provider'> = {},
  ) {
    super(`Mock queue exhausted for ${operation}.`, {
      ...options,
      details: {
        code: 'mock_queue_exhausted',
        operation,
      },
      retryable: false,
    });
  }
}

/** Session-store listing options or an opaque keyset cursor are invalid. */
export class InvalidSessionStoreListOptionsError extends LLMError {
  constructor(
    code:
      | 'invalid_session_cursor'
      | 'invalid_session_list_direction'
      | 'invalid_session_list_filter'
      | 'invalid_session_list_limit',
  ) {
    super('Session listing options are invalid.', {
      details: {
        code,
        operation: 'list',
      },
      retryable: false,
      statusCode: 400,
    });
  }
}

/** Redis session listing cannot proceed safely with the supplied scan adapter. */
export class RedisSessionStoreCapabilityError extends LLMError {
  constructor(
    operation: 'list',
    code:
      | 'redis_scan_adapter_error'
      | 'redis_scan_iteration_limit_exceeded'
      | 'redis_scan_key_limit_exceeded'
      | 'redis_scan_no_progress'
      | 'unsupported_redis_scan_capability',
  ) {
    super(
      'Redis session listing requires a bounded, cluster-safe scan iterator.',
      {
        details: {
          code,
          operation,
        },
        retryable: false,
        statusCode:
          code === 'unsupported_redis_scan_capability'
            ? 501
            : code === 'redis_scan_adapter_error'
              ? 502
              : 400,
      },
    );
  }
}

/** A v2 Redis key is occupied by a record for another tenant/session tuple. */
export class RedisSessionStoreKeyConflictError extends LLMError {
  constructor() {
    super('Redis session key conflicts with an existing session record.', {
      details: {
        code: 'redis_session_key_conflict',
        operation: 'set',
      },
      retryable: false,
      statusCode: 409,
    });
  }
}

/** Generic provider-side failure that does not fit a narrower subtype. */
export class ProviderError extends LLMError {}

function sanitizeSnapshotErrorField(value: string, fallback: string): string {
  const sanitized = value.replace(/\p{C}/gu, '?').slice(0, 256);
  return sanitized || fallback;
}
