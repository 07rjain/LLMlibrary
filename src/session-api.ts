import { SlidingWindowStrategy, type ContextManager } from './context-manager.js';
import { LLMError, ProviderCapabilityError } from './errors.js';
import { sanitizeForLogging } from './redaction.js';

import type { LLMClient } from './client.js';
import type {
  ConversationOptions,
  ConversationSnapshot,
  ToolValidationMode,
} from './conversation.js';
import type {
  SessionMeta,
  SessionRecord,
  SessionStore,
} from './session-store.js';
import type {
  CanonicalMessage,
  CanonicalProvider,
  CanonicalTool,
  CanonicalToolChoice,
  ProviderOptions,
  ResponseFormat,
} from './types.js';
import type { UsageSummary } from './usage.js';

type MaybePromise<TValue> = Promise<TValue> | TValue;
type TenantResolutionMode =
  | 'legacy-request-tenant'
  | 'single-tenant'
  | 'trusted-context';

const REDACTION_MARKER = '[REDACTED]';

/** Request-scoped metadata passed through session API middleware and handlers. */
export interface SessionApiRequestContext {
  tenantId?: string;
  [key: string]: unknown;
}

/** Middleware hook for auth, tenancy, and request enrichment. */
export type SessionApiMiddleware = (
  request: Request,
  context: SessionApiRequestContext,
) => MaybePromise<Partial<SessionApiRequestContext> | Response | void>;

/** Policy fields a public request body may carry. */
export type SessionConversationConfigField = keyof SessionConversationConfig;

/**
 * Which conversation-policy fields a browser-facing request body is allowed to
 * override. Defaults to denying all overrides so untrusted callers cannot
 * downgrade `toolValidation`, raise spend/tool limits, or swap the model,
 * provider, or system prompt away from the trusted `conversationDefaults`.
 *
 * - `false` / omitted: ignore every policy field from the request body.
 * - `true`: allow all fields (legacy behavior — only for fully trusted callers).
 * - array: allow only the listed fields.
 */
export type ClientOverridePolicy = boolean | SessionConversationConfigField[];

/** Configuration for `SessionApi` and `createSessionApi()`. */
export interface SessionApiOptions {
  /**
   * Allowlist controlling which policy fields an untrusted request body may set.
   * @default false (deny all client overrides)
   */
  allowClientOverrides?: ClientOverridePolicy;
  basePath?: string;
  client: LLMClient;
  conversationDefaults?: SessionConversationConfig;
  contextManager?: ContextManager;
  /**
   * When true, raw `tool_result` content parts are included verbatim in public
   * session projections and SSE streams. Defaults to false: tool results are
   * treated as server-internal and redacted before reaching clients, so raw
   * database/RAG rows are not exposed before assistant-level filtering.
   * @default false
   */
  exposeToolResults?: boolean;
  middleware?: SessionApiMiddleware[];
  sessionStore?: SessionStore<ConversationSnapshot>;
  tenantResolution?: TenantResolutionMode;
  tools?: CanonicalTool[];
  withRequestContext?: <TValue>(
    context: SessionApiRequestContext,
    execute: () => Promise<TValue>,
  ) => Promise<TValue>;
}

/** Shared conversation options accepted by session API write endpoints. */
export interface SessionConversationConfig {
  budgetUsd?: number;
  maxContextTokens?: number;
  maxTokens?: number;
  maxToolRounds?: number;
  model?: string;
  provider?: CanonicalProvider;
  providerOptions?: ProviderOptions;
  responseFormat?: ResponseFormat;
  system?: string;
  toolChoice?: CanonicalToolChoice;
  toolExecutionTimeoutMs?: number;
  toolValidation?: ToolValidationMode;
}

/** Request body accepted by `POST /sessions`. */
export interface SessionCreateRequest extends SessionConversationConfig {
  messages?: CanonicalMessage[];
  sessionId?: string;
  tenantId?: string;
}

/** Request body accepted by `POST /sessions/{id}/message`. */
export interface SessionMessageRequest extends SessionConversationConfig {
  content: CanonicalMessage['content'];
  stream?: boolean;
  tenantId?: string;
}

/** Request body accepted by `POST /sessions/{id}/compact`. */
export interface SessionCompactRequest {
  maxMessages?: number;
  maxTokens?: number;
  tenantId?: string;
}

/** Request body accepted by `POST /sessions/{id}/fork`. */
export interface SessionForkRequest {
  fromMessageIndex: number;
  newSessionId?: string;
  resetUsage?: boolean;
  tenantId?: string;
}

/** Cursor page wrapper returned by collection endpoints. */
export interface SessionPage<TItem> {
  items: TItem[];
  nextCursor?: string;
}

/** Normalized session view returned by `SessionApi`. */
export interface SessionView {
  createdAt: string;
  id: string;
  messageCount: number;
  messages?: CanonicalMessage[];
  model?: string;
  provider?: CanonicalProvider;
  system?: string;
  tenantId?: string;
  totals?: {
    cachedTokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  usage?: UsageSummary | null;
  updatedAt: string;
}

/**
 * Framework-agnostic HTTP handler for session lifecycle operations.
 *
 * @example
 * ```ts
 * const api = createSessionApi({
 *   client,
 *   sessionStore: PostgresSessionStore.fromEnv(),
 * });
 *
 * const response = await api.handle(new Request('https://example.test/sessions'));
 * ```
 */
export class SessionApi {
  private readonly allowedClientOverrides: ReadonlySet<SessionConversationConfigField>;
  private readonly basePath: string;
  private readonly client: LLMClient;
  private readonly contextManager: ContextManager | undefined;
  private readonly conversationDefaults: SessionConversationConfig;
  private readonly exposeToolResults: boolean;
  private readonly middleware: SessionApiMiddleware[];
  private readonly sessionStore: SessionStore<ConversationSnapshot>;
  private readonly tenantResolution: TenantResolutionMode;
  private readonly tools: CanonicalTool[] | undefined;
  private readonly withRequestContext:
    | SessionApiOptions['withRequestContext']
    | undefined;

  constructor(options: SessionApiOptions) {
    const sessionStore = options.sessionStore ?? options.client.getSessionStore();
    if (!sessionStore) {
      throw new ProviderCapabilityError(
        'SessionApi requires a session store. Configure sessionStore on LLMClient or pass sessionStore directly.',
      );
    }

    this.allowedClientOverrides = resolveClientOverridePolicy(options.allowClientOverrides);
    this.basePath = normalizeBasePath(options.basePath ?? '/sessions');
    this.client = options.client;
    this.contextManager = options.contextManager;
    this.conversationDefaults = { ...(options.conversationDefaults ?? {}) };
    this.exposeToolResults = options.exposeToolResults ?? false;
    this.middleware = [...(options.middleware ?? [])];
    this.sessionStore = sessionStore;
    this.tenantResolution = options.tenantResolution ?? 'trusted-context';
    this.tools = options.tools;
    this.withRequestContext = options.withRequestContext;
  }

  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const route = matchRoute(this.basePath, url.pathname);
      if (!route) {
        return jsonResponse(
          {
            error: {
              message: `No session API route matched ${request.method} ${url.pathname}.`,
              name: 'NotFoundError',
            },
          },
          404,
        );
      }

      const middlewareResult = await this.applyMiddleware(request);
      if (middlewareResult instanceof Response) {
        return middlewareResult;
      }

      return await this.runWithRequestContext(middlewareResult, () =>
        this.dispatch(request, url, route, middlewareResult),
      );
    } catch (error) {
      return errorToResponse(error);
    }
  }

  private async dispatch(
    request: Request,
    url: URL,
    route: MatchedRoute,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    if (route.type === 'collection') {
      if (request.method === 'GET') {
        return this.handleListSessions(url, requestContext);
      }

      if (request.method === 'POST') {
        return this.handleCreateSession(request, requestContext);
      }

      throw new HttpError(405, `Method ${request.method} is not allowed on ${route.path}.`);
    }

    if (route.type === 'session') {
      const sessionId = requireRouteSessionId(route);
      if (request.method === 'GET') {
        return this.handleGetSession(sessionId, url, requestContext);
      }

      if (request.method === 'DELETE') {
        return this.handleDeleteSession(sessionId, url, requestContext);
      }

      throw new HttpError(405, `Method ${request.method} is not allowed on ${route.path}.`);
    }

    if (route.type === 'messages') {
      const sessionId = requireRouteSessionId(route);
      if (request.method === 'GET') {
        return this.handleGetSessionMessages(sessionId, url, requestContext);
      }

      throw new HttpError(405, `Method ${request.method} is not allowed on ${route.path}.`);
    }

    if (route.type === 'message') {
      const sessionId = requireRouteSessionId(route);
      if (request.method === 'POST') {
        return this.handleSendMessage(sessionId, request, url, requestContext);
      }

      throw new HttpError(405, `Method ${request.method} is not allowed on ${route.path}.`);
    }

    if (route.type === 'compact') {
      const sessionId = requireRouteSessionId(route);
      if (request.method === 'POST') {
        return this.handleCompactSession(sessionId, request, requestContext);
      }

      throw new HttpError(405, `Method ${request.method} is not allowed on ${route.path}.`);
    }

    if (route.type === 'fork') {
      const sessionId = requireRouteSessionId(route);
      if (request.method === 'POST') {
        return this.handleForkSession(sessionId, request, requestContext);
      }

      throw new HttpError(405, `Method ${request.method} is not allowed on ${route.path}.`);
    }

    throw new HttpError(404, `Unsupported session API route ${route.path}.`);
  }

  private async handleCreateSession(
    request: Request,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const body = await parseJsonBody<SessionCreateRequest>(request);
    const history = normalizeHistoryInput(body.messages ?? [], body.system);
    const tenantId = this.resolveTenantId(requestContext, body.tenantId);
    const conversationOptions = this.buildConversationOptions(body, tenantId);
    const conversation = await this.client.conversation({
      ...conversationOptions,
      messages: history.messages,
      ...(history.system !== undefined && this.allowedClientOverrides.has('system')
        ? { system: history.system }
        : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
    const snapshot = conversation.serialise();
    await this.sessionStore.set(snapshot.sessionId, snapshot, {
      createdAt: snapshot.createdAt,
      ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
      ...(snapshot.provider !== undefined ? { provider: snapshot.provider } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
    });

    const record = await this.requireSession(snapshot.sessionId, tenantId);
    return jsonResponse(
      {
        session: await this.buildSessionView(record, new Set(['cost', 'messages'])),
      },
      201,
    );
  }

  private async handleSendMessage(
    sessionId: string,
    request: Request,
    url: URL,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const body = await parseJsonBody<SessionMessageRequest>(request);
    const tenantId = this.resolveTenantId(requestContext, body.tenantId);
    const conversation = await this.client.conversation({
      ...this.buildConversationOptions(body, tenantId),
      sessionId,
    });
    const shouldStream = body.stream ?? url.searchParams.get('stream') === 'true';

    if (shouldStream) {
      return this.streamSessionMessage(conversation, sessionId, tenantId, body.content, request.signal);
    }

    const response = await conversation.send(body.content);
    const record = await this.requireSession(sessionId, tenantId);
    const include = parseInclude(url.searchParams, ['cost', 'messages']);

    return jsonResponse({
      response,
      session: await this.buildSessionView(record, include),
    });
  }

  private async handleGetSession(
    sessionId: string,
    url: URL,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const tenantId = this.resolveTenantId(
      requestContext,
      url.searchParams.get('tenantId') ?? undefined,
    );
    const record = await this.requireSession(sessionId, tenantId);
    const include = parseInclude(url.searchParams, ['cost', 'messages']);

    return jsonResponse({
      session: await this.buildSessionView(record, include),
    });
  }

  private async handleGetSessionMessages(
    sessionId: string,
    url: URL,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const tenantId = this.resolveTenantId(
      requestContext,
      url.searchParams.get('tenantId') ?? undefined,
    );
    const record = await this.requireSession(sessionId, tenantId);
    const history = projectMessagesForClient(
      snapshotToMessages(record.snapshot),
      this.exposeToolResults,
    );
    const page = paginateItems(
      history,
      parseCursor(url.searchParams.get('cursor')),
      parseLimit(url.searchParams.get('limit'), 50),
    );

    return jsonResponse({
      messages: page,
      sessionId,
      tenantId,
    });
  }

  private async handleDeleteSession(
    sessionId: string,
    url: URL,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const tenantId = this.resolveTenantId(
      requestContext,
      url.searchParams.get('tenantId') ?? undefined,
    );
    await this.requireSession(sessionId, tenantId);
    await this.sessionStore.delete(sessionId, tenantId);

    return jsonResponse({
      deleted: true,
      sessionId,
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
  }

  private async handleCompactSession(
    sessionId: string,
    request: Request,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const body = await parseJsonBody<SessionCompactRequest>(request);
    const tenantId = this.resolveTenantId(requestContext, body.tenantId);
    const record = await this.requireSession(sessionId, tenantId);
    const contextManager =
      body.maxMessages !== undefined || body.maxTokens !== undefined
        ? new SlidingWindowStrategy({
            ...(body.maxMessages !== undefined ? { maxMessages: body.maxMessages } : {}),
            ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
          })
        : this.contextManager;

    if (!contextManager) {
      throw new HttpError(
        400,
        'Manual compaction requires either SessionApi.contextManager or maxMessages/maxTokens in the request body.',
      );
    }

    const trimContext = {
      ...(record.snapshot.maxContextTokens !== undefined
        ? { maxContextTokens: record.snapshot.maxContextTokens }
        : {}),
      ...(record.snapshot.model !== undefined ? { model: record.snapshot.model } : {}),
      ...(record.snapshot.provider !== undefined ? { provider: record.snapshot.provider } : {}),
      ...(record.snapshot.system !== undefined ? { system: record.snapshot.system } : {}),
    };
    const beforeCount = record.snapshot.messages.length;
    const trimmedMessages = (await contextManager.trim(
      record.snapshot.messages,
      trimContext,
    )) as ConversationSnapshot['messages'];
    const updatedSnapshot: ConversationSnapshot = {
      ...cloneSnapshot(record.snapshot),
      messages: trimmedMessages,
      updatedAt: new Date().toISOString(),
    };
    const updatedRecord = await this.sessionStore.set(sessionId, updatedSnapshot, {
      createdAt: updatedSnapshot.createdAt,
      ...(updatedSnapshot.model !== undefined ? { model: updatedSnapshot.model } : {}),
      ...(updatedSnapshot.provider !== undefined ? { provider: updatedSnapshot.provider } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
    });

    return jsonResponse({
      compacted: updatedSnapshot.messages.length < beforeCount,
      removedCount: beforeCount - updatedSnapshot.messages.length,
      session: await this.buildSessionView(updatedRecord, new Set(['cost', 'messages'])),
    });
  }

  private async handleForkSession(
    sessionId: string,
    request: Request,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const body = await parseJsonBody<SessionForkRequest>(request);
    const tenantId = this.resolveTenantId(requestContext, body.tenantId);
    const record = await this.requireSession(sessionId, tenantId);
    const fullHistory = snapshotToMessages(record.snapshot);

    if (!Number.isInteger(body.fromMessageIndex)) {
      throw new HttpError(400, 'fromMessageIndex must be an integer.');
    }

    if (body.fromMessageIndex < 0 || body.fromMessageIndex >= fullHistory.length) {
      throw new HttpError(
        400,
        `fromMessageIndex must be between 0 and ${Math.max(fullHistory.length - 1, 0)}.`,
      );
    }

    const forkedHistory = fullHistory.slice(0, body.fromMessageIndex + 1);
    const forkedParts = splitHistoryForSnapshot(forkedHistory);
    const timestamp = new Date().toISOString();
    const newSessionId = body.newSessionId ?? createSessionId();
    const resetUsage = body.resetUsage ?? true;
    const forkedSnapshotBase: ConversationSnapshot = {
      ...cloneSnapshot(record.snapshot),
      createdAt: timestamp,
      messages: forkedParts.messages,
      sessionId: newSessionId,
      updatedAt: timestamp,
      ...(resetUsage
        ? {
            totalCachedTokens: 0,
            totalCostUSD: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalReasoningTokens: 0,
          }
        : {}),
    };
    const forkedSnapshot =
      forkedParts.system !== undefined
        ? {
            ...forkedSnapshotBase,
            system: forkedParts.system,
          }
        : stripSystemFromSnapshot(forkedSnapshotBase);
    if (forkedParts.system === undefined && 'system' in forkedSnapshot) {
      delete forkedSnapshot.system;
    }

    const forkedRecord = await this.sessionStore.set(newSessionId, forkedSnapshot, {
      createdAt: timestamp,
      ...(forkedSnapshot.model !== undefined ? { model: forkedSnapshot.model } : {}),
      ...(forkedSnapshot.provider !== undefined ? { provider: forkedSnapshot.provider } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
    });

    return jsonResponse(
      {
        forkedFromMessageIndex: body.fromMessageIndex,
        forkedFromSessionId: sessionId,
        resetUsage,
        session: await this.buildSessionView(forkedRecord, new Set(['cost', 'messages'])),
      },
      201,
    );
  }

  private async handleListSessions(
    url: URL,
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const tenantId = this.resolveTenantId(
      requestContext,
      url.searchParams.get('tenantId') ?? undefined,
    );
    const allSessions = await this.sessionStore.list({
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
    const filtered = allSessions.filter((session) => {
      const model = url.searchParams.get('model');
      if (model && session.model !== model) {
        return false;
      }

      const provider = url.searchParams.get('provider');
      if (provider && session.provider !== provider) {
        return false;
      }

      return true;
    });
    const page = paginateItems(
      filtered,
      parseCursor(url.searchParams.get('cursor')),
      parseLimit(url.searchParams.get('limit'), 20),
    );

    return jsonResponse({
      sessions: page,
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
  }

  private async buildSessionView(
    record: SessionRecord<ConversationSnapshot>,
    include: Set<string>,
  ): Promise<SessionView> {
    const view: SessionView = {
      createdAt: record.meta.createdAt,
      id: record.meta.sessionId,
      messageCount: record.meta.messageCount,
      updatedAt: record.meta.updatedAt,
      ...(record.meta.model !== undefined ? { model: record.meta.model } : {}),
      ...(record.meta.provider !== undefined ? { provider: record.meta.provider } : {}),
      ...(record.meta.tenantId !== undefined ? { tenantId: record.meta.tenantId } : {}),
      ...(record.snapshot.system !== undefined ? { system: record.snapshot.system } : {}),
    };

    if (include.has('messages')) {
      view.messages = projectMessagesForClient(
        snapshotToMessages(record.snapshot),
        this.exposeToolResults,
      );
    }

    if (include.has('cost')) {
      view.totals = {
        cachedTokens: record.snapshot.totalCachedTokens,
        costUSD: record.snapshot.totalCostUSD,
        inputTokens: record.snapshot.totalInputTokens,
        outputTokens: record.snapshot.totalOutputTokens,
        reasoningTokens: record.snapshot.totalReasoningTokens ?? 0,
      };
    }

    if (include.has('usage')) {
      view.usage = await this.safeGetUsage(record.meta.sessionId, record.meta.tenantId);
    }

    return view;
  }

  private buildConversationOptions(
    config: SessionConversationConfig,
    tenantId: string | undefined,
  ): Omit<ConversationOptions, 'messages' | 'sessionId' | 'store'> {
    // Start from the trusted server policy, then layer only the client-supplied
    // fields the server has explicitly allowlisted. Untrusted request-body
    // fields never silently override server policy (spend caps, tool validation,
    // model/provider/system, etc.).
    const merged: SessionConversationConfig = { ...this.conversationDefaults };
    for (const field of CONVERSATION_CONFIG_FIELDS) {
      if (config[field] !== undefined && this.allowedClientOverrides.has(field)) {
        assignConfigField(merged, config, field);
      }
    }

    return {
      ...(merged.budgetUsd !== undefined ? { budgetUsd: merged.budgetUsd } : {}),
      ...(merged.maxContextTokens !== undefined
        ? { maxContextTokens: merged.maxContextTokens }
        : {}),
      ...(merged.maxTokens !== undefined ? { maxTokens: merged.maxTokens } : {}),
      ...(merged.maxToolRounds !== undefined ? { maxToolRounds: merged.maxToolRounds } : {}),
      ...(merged.model !== undefined ? { model: merged.model } : {}),
      ...(merged.provider !== undefined ? { provider: merged.provider } : {}),
      ...(merged.providerOptions !== undefined
        ? { providerOptions: merged.providerOptions }
        : {}),
      ...(merged.responseFormat !== undefined ? { responseFormat: merged.responseFormat } : {}),
      ...(merged.system !== undefined ? { system: merged.system } : {}),
      ...(merged.toolChoice !== undefined ? { toolChoice: merged.toolChoice } : {}),
      ...(merged.toolExecutionTimeoutMs !== undefined
        ? { toolExecutionTimeoutMs: merged.toolExecutionTimeoutMs }
        : {}),
      ...(merged.toolValidation !== undefined ? { toolValidation: merged.toolValidation } : {}),
      ...(this.contextManager !== undefined ? { contextManager: this.contextManager } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(this.tools !== undefined ? { tools: this.tools } : {}),
    };
  }

  private async streamSessionMessage(
    conversation: Awaited<ReturnType<LLMClient['conversation']>>,
    sessionId: string,
    tenantId: string | undefined,
    content: CanonicalMessage['content'],
    requestSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    let stream: ReturnType<typeof conversation.sendStream> | undefined;
    let removeRequestAbortListener: (() => void) | undefined;

    if (requestSignal) {
      if (requestSignal.aborted) {
        abortController.abort(requestSignal.reason);
      } else {
        const onAbort = () => {
          abortController.abort(requestSignal.reason);
          stream?.cancel(requestSignal.reason);
        };
        requestSignal.addEventListener('abort', onAbort, { once: true });
        removeRequestAbortListener = () => {
          requestSignal.removeEventListener('abort', onAbort);
        };
      }
    }

    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          controller.enqueue(encoder.encode(formatSseEvent('session.message.started', { sessionId })));

          stream = conversation.sendStream(content, { signal: abortController.signal });
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta') {
              controller.enqueue(
                encoder.encode(formatSseEvent('response.text.delta', { delta: chunk.delta })),
              );
              continue;
            }

            if (chunk.type === 'tool-call-start') {
              controller.enqueue(
                encoder.encode(
                  formatSseEvent('response.tool_call.start', {
                    id: chunk.id,
                    name: chunk.name,
                  }),
                ),
              );
              continue;
            }

            if (chunk.type === 'tool-call-delta') {
              controller.enqueue(
                encoder.encode(
                  formatSseEvent('response.tool_call.delta', {
                    argsDelta: chunk.argsDelta,
                    id: chunk.id,
                  }),
                ),
              );
              continue;
            }

            if (chunk.type === 'tool-call-result') {
              const resultPayload = this.exposeToolResults
                ? { result: chunk.result }
                : { redacted: true, result: TOOL_RESULT_REDACTION };
              controller.enqueue(
                encoder.encode(
                  formatSseEvent('response.tool_call.result', {
                    id: chunk.id,
                    name: chunk.name,
                    ...resultPayload,
                  }),
                ),
              );
              continue;
            }

            if (chunk.type === 'error') {
              controller.enqueue(
                encoder.encode(
                  formatSseEvent('response.error', serializeStreamError(chunk.error)),
                ),
              );
              continue;
            }

            const record = await this.requireSession(sessionId, tenantId);
            controller.enqueue(
              encoder.encode(
                formatSseEvent('response.completed', {
                  finishReason: chunk.finishReason,
                  session: await this.buildSessionView(record, new Set(['cost', 'messages'])),
                  usage: chunk.usage,
                }),
              ),
            );
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            controller.enqueue(
              encoder.encode(formatSseEvent('response.error', serializeStreamError(error))),
            );
          }
        } finally {
          removeRequestAbortListener?.();
          try {
            controller.close();
          } catch {
            // The stream may already be closed when the client disconnects.
          }
        }
      },
      cancel: (reason) => {
        abortController.abort(reason);
        stream?.cancel(reason);
        removeRequestAbortListener?.();
      },
    });

    return new Response(body, {
      headers: {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      },
      status: 200,
    });
  }

  private async requireSession(
    sessionId: string,
    tenantId: string | undefined,
  ): Promise<SessionRecord<ConversationSnapshot>> {
    const record = await this.sessionStore.get(sessionId, tenantId);
    if (!record) {
      throw new HttpError(404, `Session "${sessionId}" was not found.`);
    }

    return record;
  }

  private async safeGetUsage(
    sessionId: string,
    tenantId: string | undefined,
  ): Promise<UsageSummary | null> {
    try {
      return await this.client.getUsage({
        sessionId,
        ...(tenantId !== undefined ? { tenantId } : {}),
      });
    } catch (error) {
      if (error instanceof ProviderCapabilityError) {
        return null;
      }

      throw error;
    }
  }

  private async applyMiddleware(
    request: Request,
  ): Promise<Response | SessionApiRequestContext> {
    const context: SessionApiRequestContext = {};

    for (const middleware of this.middleware) {
      const result = await middleware(request, { ...context });
      if (result instanceof Response) {
        return result;
      }

      if (result) {
        Object.assign(context, result);
      }
    }

    return context;
  }

  private async runWithRequestContext<TValue>(
    context: SessionApiRequestContext,
    execute: () => Promise<TValue>,
  ): Promise<TValue> {
    if (!this.withRequestContext) {
      return execute();
    }

    return this.withRequestContext(context, execute);
  }

  private resolveTenantId(
    requestContext: SessionApiRequestContext,
    requestedTenantId: string | undefined,
  ): string | undefined {
    if (requestedTenantId !== undefined) {
      if (this.tenantResolution === 'legacy-request-tenant') {
        return requestContext.tenantId ?? requestedTenantId;
      }

      throw new HttpError(
        400,
        'Request-supplied tenantId is not allowed. Resolve tenantId in trusted middleware context.',
      );
    }

    return requestContext.tenantId;
  }
}

/** Creates a framework-agnostic session API instance. */
export function createSessionApi(options: SessionApiOptions): SessionApi {
  return new SessionApi(options);
}

interface MatchedRoute {
  path: string;
  sessionId?: string;
  type: 'collection' | 'compact' | 'fork' | 'message' | 'messages' | 'session';
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function matchRoute(basePath: string, pathname: string): MatchedRoute | null {
  const normalizedPath = trimTrailingSlash(pathname);
  if (normalizedPath === basePath) {
    return {
      path: normalizedPath,
      type: 'collection',
    };
  }

  if (!normalizedPath.startsWith(`${basePath}/`)) {
    return null;
  }

  const segments = normalizedPath.slice(basePath.length + 1).split('/');
  const sessionId = decodeURIComponent(segments[0] ?? '');
  if (!sessionId) {
    return null;
  }

  if (segments.length === 1) {
    return {
      path: normalizedPath,
      sessionId,
      type: 'session',
    };
  }

  const action = segments[1];
  if (action === 'message' && segments.length === 2) {
    return {
      path: normalizedPath,
      sessionId,
      type: 'message',
    };
  }

  if (action === 'messages' && segments.length === 2) {
    return {
      path: normalizedPath,
      sessionId,
      type: 'messages',
    };
  }

  if (action === 'compact' && segments.length === 2) {
    return {
      path: normalizedPath,
      sessionId,
      type: 'compact',
    };
  }

  if (action === 'fork' && segments.length === 2) {
    return {
      path: normalizedPath,
      sessionId,
      type: 'fork',
    };
  }

  return null;
}

function normalizeBasePath(basePath: string): string {
  return trimTrailingSlash(basePath.startsWith('/') ? basePath : `/${basePath}`);
}

function trimTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

async function parseJsonBody<TValue>(request: Request): Promise<TValue> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return {} as TValue;
  }

  try {
    return JSON.parse(text) as TValue;
  } catch (error) {
    throw new HttpError(
      400,
      `Request body must be valid JSON.${error instanceof Error ? ` ${error.message}` : ''}`,
    );
  }
}

function parseInclude(searchParams: URLSearchParams, defaults: string[] = []): Set<string> {
  const include = new Set<string>(defaults);

  for (const value of searchParams.getAll('include')) {
    for (const item of value.split(',')) {
      const normalized = item.trim();
      if (normalized) {
        include.add(normalized);
      }
    }
  }

  return include;
}

function parseCursor(cursor: null | string): number {
  if (!cursor) {
    return 0;
  }

  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, 'cursor must be a non-negative integer.');
  }

  return parsed;
}

function parseLimit(limit: null | string, defaultLimit: number): number {
  if (!limit) {
    return defaultLimit;
  }

  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new HttpError(400, 'limit must be an integer between 1 and 100.');
  }

  return parsed;
}

function paginateItems<TItem>(
  items: TItem[],
  cursor: number,
  limit: number,
): SessionPage<TItem> {
  const pageItems = items.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < items.length ? String(cursor + limit) : undefined;

  return {
    items: pageItems,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function normalizeHistoryInput(
  messages: CanonicalMessage[],
  system: string | undefined,
): {
  messages: CanonicalMessage[];
  system?: string;
} {
  const firstMessage = messages[0];
  const leadingSystem =
    firstMessage?.role === 'system' && typeof firstMessage.content === 'string'
      ? firstMessage.content
      : undefined;
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');

  return {
    messages: nonSystemMessages.map(cloneMessage),
    ...(system !== undefined
      ? { system }
      : leadingSystem !== undefined
        ? { system: leadingSystem }
        : {}),
  };
}

function snapshotToMessages(snapshot: ConversationSnapshot): CanonicalMessage[] {
  return snapshot.system
    ? [{ content: snapshot.system, pinned: true, role: 'system' }, ...snapshot.messages.map(cloneMessage)]
    : snapshot.messages.map(cloneMessage);
}

function splitHistoryForSnapshot(messages: CanonicalMessage[]): {
  messages: CanonicalMessage[];
  system?: string;
} {
  const [firstMessage, ...rest] = messages;
  if (firstMessage?.role === 'system' && typeof firstMessage.content === 'string') {
    return {
      messages: rest.map(cloneMessage),
      system: firstMessage.content,
    };
  }

  return {
    messages: messages.map(cloneMessage),
  };
}

function cloneSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ConversationSnapshot;
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return JSON.parse(JSON.stringify(message)) as CanonicalMessage;
}

/** Every policy field a request body may carry, used to drive the allowlist. */
const CONVERSATION_CONFIG_FIELDS: readonly SessionConversationConfigField[] = [
  'budgetUsd',
  'maxContextTokens',
  'maxTokens',
  'maxToolRounds',
  'model',
  'provider',
  'providerOptions',
  'responseFormat',
  'system',
  'toolChoice',
  'toolExecutionTimeoutMs',
  'toolValidation',
];

function assignConfigField(
  target: SessionConversationConfig,
  source: SessionConversationConfig,
  field: SessionConversationConfigField,
): void {
  // Narrow, type-safe copy of a single known field between configs.
  (target as Record<string, unknown>)[field] = source[field];
}

function resolveClientOverridePolicy(
  policy: ClientOverridePolicy | undefined,
): ReadonlySet<SessionConversationConfigField> {
  if (policy === true) {
    return new Set(CONVERSATION_CONFIG_FIELDS);
  }
  if (Array.isArray(policy)) {
    return new Set(policy);
  }
  return new Set();
}

const TOOL_RESULT_REDACTION = '[tool result withheld]';

/**
 * Redact `tool_result` parts from a message before it reaches a public client.
 * Tool results carry raw database/RAG output that should stay server-internal;
 * the part is kept (so tool-call/result pairing is visible) but its payload is
 * replaced with a placeholder. Returns the message unchanged when it has no
 * tool results, avoiding needless allocation.
 */
function redactToolResults(message: CanonicalMessage): CanonicalMessage {
  if (typeof message.content === 'string') {
    return message;
  }
  if (!message.content.some((part) => part.type === 'tool_result')) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === 'tool_result'
        ? { ...part, redacted: true, result: TOOL_RESULT_REDACTION }
        : part,
    ),
  };
}

function projectMessagesForClient(
  messages: CanonicalMessage[],
  exposeToolResults: boolean,
): CanonicalMessage[] {
  if (exposeToolResults) {
    return messages;
  }
  return messages.map(redactToolResults);
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function requireRouteSessionId(route: MatchedRoute): string {
  if (!route.sessionId) {
    throw new HttpError(500, `Route ${route.path} is missing a session id.`);
  }

  return route.sessionId;
}

function stripSystemFromSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  const next = cloneSnapshot(snapshot) as ConversationSnapshot & { system?: string };
  delete next.system;
  return next;
}

function serializeStreamError(error: Error | unknown): PublicSessionApiError {
  return serializePublicError(error);
}

interface PublicSessionApiError {
  message: string;
  name: string;
  provider?: CanonicalProvider;
  requestId?: string;
  statusCode?: number;
}

function serializePublicError(error: unknown): PublicSessionApiError {
  if (error instanceof HttpError) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  if (error instanceof LLMError) {
    return {
      message: safeLlmErrorMessage(error),
      name: error.name,
      ...(error.provider !== undefined ? { provider: error.provider } : {}),
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      message: 'Internal session API error.',
      name: error.name,
    };
  }

  return {
    message: 'Unknown streaming error.',
    name: 'Error',
  };
}

function safeLlmErrorMessage(error: LLMError): string {
  const sanitized = sanitizeForLogging(error.message);
  if (typeof sanitized !== 'string' || sanitized.includes(REDACTION_MARKER)) {
    return 'LLM provider request failed.';
  }

  return sanitized;
}

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return Response.json(body, {
    headers: {
      'content-type': 'application/json',
    },
    status,
  });
}

function errorToResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: serializePublicError(error) }, error.status);
  }

  if (error instanceof LLMError) {
    return jsonResponse({ error: serializePublicError(error) }, error.statusCode ?? (error.retryable ? 503 : 500));
  }

  if (error instanceof Error) {
    return jsonResponse({ error: serializePublicError(error) }, 500);
  }

  return jsonResponse(
    {
      error: {
        message: 'Unknown session API error.',
        name: 'Error',
      },
    },
    500,
  );
}

export type { SessionMeta, SessionRecord, SessionStore };
