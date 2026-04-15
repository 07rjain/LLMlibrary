import { SlidingWindowStrategy, type ContextManager } from './context-manager.js';
import { LLMError, ProviderCapabilityError } from './errors.js';

import type { LLMClient } from './client.js';
import type { ConversationOptions, ConversationSnapshot } from './conversation.js';
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
} from './types.js';
import type { UsageSummary } from './usage.js';

type MaybePromise<TValue> = Promise<TValue> | TValue;

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

/** Configuration for `SessionApi` and `createSessionApi()`. */
export interface SessionApiOptions {
  basePath?: string;
  client: LLMClient;
  conversationDefaults?: SessionConversationConfig;
  contextManager?: ContextManager;
  middleware?: SessionApiMiddleware[];
  sessionStore?: SessionStore<ConversationSnapshot>;
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
  system?: string;
  toolChoice?: CanonicalToolChoice;
  toolExecutionTimeoutMs?: number;
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
  private readonly basePath: string;
  private readonly client: LLMClient;
  private readonly contextManager: ContextManager | undefined;
  private readonly conversationDefaults: SessionConversationConfig;
  private readonly middleware: SessionApiMiddleware[];
  private readonly sessionStore: SessionStore<ConversationSnapshot>;
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

    this.basePath = normalizeBasePath(options.basePath ?? '/sessions');
    this.client = options.client;
    this.contextManager = options.contextManager;
    this.conversationDefaults = { ...(options.conversationDefaults ?? {}) };
    this.middleware = [...(options.middleware ?? [])];
    this.sessionStore = sessionStore;
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
        return this.handleDeleteSession(sessionId, requestContext);
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
    const tenantId = resolveTenantId(requestContext, body.tenantId);
    const conversation = await this.client.conversation({
      ...this.buildConversationOptions(body, tenantId),
      messages: history.messages,
      ...(history.system !== undefined ? { system: history.system } : {}),
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
    const tenantId = resolveTenantId(requestContext, body.tenantId);
    const conversation = await this.client.conversation({
      ...this.buildConversationOptions(body, tenantId),
      sessionId,
    });
    const shouldStream = body.stream ?? url.searchParams.get('stream') === 'true';

    if (shouldStream) {
      return this.streamSessionMessage(conversation, sessionId, tenantId, body.content);
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
    const tenantId = resolveTenantId(requestContext, url.searchParams.get('tenantId') ?? undefined);
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
    const tenantId = resolveTenantId(requestContext, url.searchParams.get('tenantId') ?? undefined);
    const record = await this.requireSession(sessionId, tenantId);
    const history = snapshotToMessages(record.snapshot);
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
    requestContext: SessionApiRequestContext,
  ): Promise<Response> {
    const tenantId = requestContext.tenantId;
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
    const tenantId = resolveTenantId(requestContext, body.tenantId);
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
    const tenantId = resolveTenantId(requestContext, body.tenantId);
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
    const tenantId = resolveTenantId(requestContext, url.searchParams.get('tenantId') ?? undefined);
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
      view.messages = snapshotToMessages(record.snapshot);
    }

    if (include.has('cost')) {
      view.totals = {
        cachedTokens: record.snapshot.totalCachedTokens,
        costUSD: record.snapshot.totalCostUSD,
        inputTokens: record.snapshot.totalInputTokens,
        outputTokens: record.snapshot.totalOutputTokens,
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
    return {
      ...(this.conversationDefaults.budgetUsd !== undefined
        ? { budgetUsd: this.conversationDefaults.budgetUsd }
        : {}),
      ...(this.conversationDefaults.maxContextTokens !== undefined
        ? { maxContextTokens: this.conversationDefaults.maxContextTokens }
        : {}),
      ...(this.conversationDefaults.maxTokens !== undefined
        ? { maxTokens: this.conversationDefaults.maxTokens }
        : {}),
      ...(this.conversationDefaults.maxToolRounds !== undefined
        ? { maxToolRounds: this.conversationDefaults.maxToolRounds }
        : {}),
      ...(this.conversationDefaults.model !== undefined
        ? { model: this.conversationDefaults.model }
        : {}),
      ...(this.conversationDefaults.provider !== undefined
        ? { provider: this.conversationDefaults.provider }
        : {}),
      ...(this.conversationDefaults.system !== undefined
        ? { system: this.conversationDefaults.system }
        : {}),
      ...(this.conversationDefaults.toolChoice !== undefined
        ? { toolChoice: this.conversationDefaults.toolChoice }
        : {}),
      ...(this.conversationDefaults.toolExecutionTimeoutMs !== undefined
        ? { toolExecutionTimeoutMs: this.conversationDefaults.toolExecutionTimeoutMs }
        : {}),
      ...(this.contextManager !== undefined ? { contextManager: this.contextManager } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(this.tools !== undefined ? { tools: this.tools } : {}),
      ...(config.budgetUsd !== undefined ? { budgetUsd: config.budgetUsd } : {}),
      ...(config.maxContextTokens !== undefined ? { maxContextTokens: config.maxContextTokens } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
      ...(config.maxToolRounds !== undefined ? { maxToolRounds: config.maxToolRounds } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      ...(config.system !== undefined ? { system: config.system } : {}),
      ...(config.toolChoice !== undefined ? { toolChoice: config.toolChoice } : {}),
      ...(config.toolExecutionTimeoutMs !== undefined
        ? { toolExecutionTimeoutMs: config.toolExecutionTimeoutMs }
        : {}),
    };
  }

  private async streamSessionMessage(
    conversation: Awaited<ReturnType<LLMClient['conversation']>>,
    sessionId: string,
    tenantId: string | undefined,
    content: CanonicalMessage['content'],
  ): Promise<Response> {
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          controller.enqueue(encoder.encode(formatSseEvent('session.message.started', { sessionId })));

          for await (const chunk of conversation.sendStream(content)) {
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
              controller.enqueue(
                encoder.encode(
                  formatSseEvent('response.tool_call.result', {
                    id: chunk.id,
                    name: chunk.name,
                    result: chunk.result,
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
          controller.enqueue(
            encoder.encode(formatSseEvent('response.error', serializeStreamError(error))),
          );
        } finally {
          controller.close();
        }
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

function resolveTenantId(
  requestContext: SessionApiRequestContext,
  requestedTenantId: string | undefined,
): string | undefined {
  return requestContext.tenantId ?? requestedTenantId;
}

function normalizeHistoryInput(
  messages: CanonicalMessage[],
  system: string | undefined,
): {
  messages: CanonicalMessage[];
  system?: string;
} {
  if (messages.length === 0) {
    return {
      messages: [],
      ...(system !== undefined ? { system } : {}),
    };
  }

  const [firstMessage, ...rest] = messages;
  if (
    firstMessage?.role === 'system' &&
    typeof firstMessage.content === 'string' &&
    system === undefined
  ) {
    return {
      messages: rest.map(cloneMessage),
      system: firstMessage.content,
    };
  }

  return {
    messages: messages.map(cloneMessage),
    ...(system !== undefined ? { system } : {}),
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

function serializeStreamError(
  error: Error | unknown,
): {
  message: string;
  name: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    message: 'Unknown streaming error.',
    name: 'Error',
  };
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
    return jsonResponse(
      {
        error: {
          message: error.message,
          name: error.name,
        },
      },
      error.status,
    );
  }

  if (error instanceof LLMError) {
    return jsonResponse(
      {
        error: {
          details: error.details,
          message: error.message,
          name: error.name,
          provider: error.provider,
          statusCode: error.statusCode,
        },
      },
      error.statusCode ?? (error.retryable ? 503 : 500),
    );
  }

  if (error instanceof Error) {
    return jsonResponse(
      {
        error: {
          message: error.message,
          name: error.name,
        },
      },
      500,
    );
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
