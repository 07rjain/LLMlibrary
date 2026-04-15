import { SlidingWindowStrategy } from './context-manager.js';
import { LLMError, ProviderCapabilityError } from './errors.js';
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
    basePath;
    client;
    contextManager;
    conversationDefaults;
    middleware;
    sessionStore;
    tools;
    withRequestContext;
    constructor(options) {
        const sessionStore = options.sessionStore ?? options.client.getSessionStore();
        if (!sessionStore) {
            throw new ProviderCapabilityError('SessionApi requires a session store. Configure sessionStore on LLMClient or pass sessionStore directly.');
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
    async handle(request) {
        try {
            const url = new URL(request.url);
            const route = matchRoute(this.basePath, url.pathname);
            if (!route) {
                return jsonResponse({
                    error: {
                        message: `No session API route matched ${request.method} ${url.pathname}.`,
                        name: 'NotFoundError',
                    },
                }, 404);
            }
            const middlewareResult = await this.applyMiddleware(request);
            if (middlewareResult instanceof Response) {
                return middlewareResult;
            }
            return await this.runWithRequestContext(middlewareResult, () => this.dispatch(request, url, route, middlewareResult));
        }
        catch (error) {
            return errorToResponse(error);
        }
    }
    async dispatch(request, url, route, requestContext) {
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
    async handleCreateSession(request, requestContext) {
        const body = await parseJsonBody(request);
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
        return jsonResponse({
            session: await this.buildSessionView(record, new Set(['cost', 'messages'])),
        }, 201);
    }
    async handleSendMessage(sessionId, request, url, requestContext) {
        const body = await parseJsonBody(request);
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
    async handleGetSession(sessionId, url, requestContext) {
        const tenantId = resolveTenantId(requestContext, url.searchParams.get('tenantId') ?? undefined);
        const record = await this.requireSession(sessionId, tenantId);
        const include = parseInclude(url.searchParams, ['cost', 'messages']);
        return jsonResponse({
            session: await this.buildSessionView(record, include),
        });
    }
    async handleGetSessionMessages(sessionId, url, requestContext) {
        const tenantId = resolveTenantId(requestContext, url.searchParams.get('tenantId') ?? undefined);
        const record = await this.requireSession(sessionId, tenantId);
        const history = snapshotToMessages(record.snapshot);
        const page = paginateItems(history, parseCursor(url.searchParams.get('cursor')), parseLimit(url.searchParams.get('limit'), 50));
        return jsonResponse({
            messages: page,
            sessionId,
            tenantId,
        });
    }
    async handleDeleteSession(sessionId, requestContext) {
        const tenantId = requestContext.tenantId;
        await this.requireSession(sessionId, tenantId);
        await this.sessionStore.delete(sessionId, tenantId);
        return jsonResponse({
            deleted: true,
            sessionId,
            ...(tenantId !== undefined ? { tenantId } : {}),
        });
    }
    async handleCompactSession(sessionId, request, requestContext) {
        const body = await parseJsonBody(request);
        const tenantId = resolveTenantId(requestContext, body.tenantId);
        const record = await this.requireSession(sessionId, tenantId);
        const contextManager = body.maxMessages !== undefined || body.maxTokens !== undefined
            ? new SlidingWindowStrategy({
                ...(body.maxMessages !== undefined ? { maxMessages: body.maxMessages } : {}),
                ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
            })
            : this.contextManager;
        if (!contextManager) {
            throw new HttpError(400, 'Manual compaction requires either SessionApi.contextManager or maxMessages/maxTokens in the request body.');
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
        const trimmedMessages = (await contextManager.trim(record.snapshot.messages, trimContext));
        const updatedSnapshot = {
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
    async handleForkSession(sessionId, request, requestContext) {
        const body = await parseJsonBody(request);
        const tenantId = resolveTenantId(requestContext, body.tenantId);
        const record = await this.requireSession(sessionId, tenantId);
        const fullHistory = snapshotToMessages(record.snapshot);
        if (!Number.isInteger(body.fromMessageIndex)) {
            throw new HttpError(400, 'fromMessageIndex must be an integer.');
        }
        if (body.fromMessageIndex < 0 || body.fromMessageIndex >= fullHistory.length) {
            throw new HttpError(400, `fromMessageIndex must be between 0 and ${Math.max(fullHistory.length - 1, 0)}.`);
        }
        const forkedHistory = fullHistory.slice(0, body.fromMessageIndex + 1);
        const forkedParts = splitHistoryForSnapshot(forkedHistory);
        const timestamp = new Date().toISOString();
        const newSessionId = body.newSessionId ?? createSessionId();
        const resetUsage = body.resetUsage ?? true;
        const forkedSnapshotBase = {
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
        const forkedSnapshot = forkedParts.system !== undefined
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
        return jsonResponse({
            forkedFromMessageIndex: body.fromMessageIndex,
            forkedFromSessionId: sessionId,
            resetUsage,
            session: await this.buildSessionView(forkedRecord, new Set(['cost', 'messages'])),
        }, 201);
    }
    async handleListSessions(url, requestContext) {
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
        const page = paginateItems(filtered, parseCursor(url.searchParams.get('cursor')), parseLimit(url.searchParams.get('limit'), 20));
        return jsonResponse({
            sessions: page,
            ...(tenantId !== undefined ? { tenantId } : {}),
        });
    }
    async buildSessionView(record, include) {
        const view = {
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
    buildConversationOptions(config, tenantId) {
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
    async streamSessionMessage(conversation, sessionId, tenantId, content) {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start: async (controller) => {
                try {
                    controller.enqueue(encoder.encode(formatSseEvent('session.message.started', { sessionId })));
                    for await (const chunk of conversation.sendStream(content)) {
                        if (chunk.type === 'text-delta') {
                            controller.enqueue(encoder.encode(formatSseEvent('response.text.delta', { delta: chunk.delta })));
                            continue;
                        }
                        if (chunk.type === 'tool-call-start') {
                            controller.enqueue(encoder.encode(formatSseEvent('response.tool_call.start', {
                                id: chunk.id,
                                name: chunk.name,
                            })));
                            continue;
                        }
                        if (chunk.type === 'tool-call-delta') {
                            controller.enqueue(encoder.encode(formatSseEvent('response.tool_call.delta', {
                                argsDelta: chunk.argsDelta,
                                id: chunk.id,
                            })));
                            continue;
                        }
                        if (chunk.type === 'tool-call-result') {
                            controller.enqueue(encoder.encode(formatSseEvent('response.tool_call.result', {
                                id: chunk.id,
                                name: chunk.name,
                                result: chunk.result,
                            })));
                            continue;
                        }
                        if (chunk.type === 'error') {
                            controller.enqueue(encoder.encode(formatSseEvent('response.error', serializeStreamError(chunk.error))));
                            continue;
                        }
                        const record = await this.requireSession(sessionId, tenantId);
                        controller.enqueue(encoder.encode(formatSseEvent('response.completed', {
                            finishReason: chunk.finishReason,
                            session: await this.buildSessionView(record, new Set(['cost', 'messages'])),
                            usage: chunk.usage,
                        })));
                    }
                }
                catch (error) {
                    controller.enqueue(encoder.encode(formatSseEvent('response.error', serializeStreamError(error))));
                }
                finally {
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
    async requireSession(sessionId, tenantId) {
        const record = await this.sessionStore.get(sessionId, tenantId);
        if (!record) {
            throw new HttpError(404, `Session "${sessionId}" was not found.`);
        }
        return record;
    }
    async safeGetUsage(sessionId, tenantId) {
        try {
            return await this.client.getUsage({
                sessionId,
                ...(tenantId !== undefined ? { tenantId } : {}),
            });
        }
        catch (error) {
            if (error instanceof ProviderCapabilityError) {
                return null;
            }
            throw error;
        }
    }
    async applyMiddleware(request) {
        const context = {};
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
    async runWithRequestContext(context, execute) {
        if (!this.withRequestContext) {
            return execute();
        }
        return this.withRequestContext(context, execute);
    }
}
/** Creates a framework-agnostic session API instance. */
export function createSessionApi(options) {
    return new SessionApi(options);
}
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}
function matchRoute(basePath, pathname) {
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
function normalizeBasePath(basePath) {
    return trimTrailingSlash(basePath.startsWith('/') ? basePath : `/${basePath}`);
}
function trimTrailingSlash(pathname) {
    if (pathname.length > 1 && pathname.endsWith('/')) {
        return pathname.slice(0, -1);
    }
    return pathname;
}
async function parseJsonBody(request) {
    const text = await request.text();
    if (text.trim().length === 0) {
        return {};
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new HttpError(400, `Request body must be valid JSON.${error instanceof Error ? ` ${error.message}` : ''}`);
    }
}
function parseInclude(searchParams, defaults = []) {
    const include = new Set(defaults);
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
function parseCursor(cursor) {
    if (!cursor) {
        return 0;
    }
    const parsed = Number(cursor);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new HttpError(400, 'cursor must be a non-negative integer.');
    }
    return parsed;
}
function parseLimit(limit, defaultLimit) {
    if (!limit) {
        return defaultLimit;
    }
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
        throw new HttpError(400, 'limit must be an integer between 1 and 100.');
    }
    return parsed;
}
function paginateItems(items, cursor, limit) {
    const pageItems = items.slice(cursor, cursor + limit);
    const nextCursor = cursor + limit < items.length ? String(cursor + limit) : undefined;
    return {
        items: pageItems,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
}
function resolveTenantId(requestContext, requestedTenantId) {
    return requestContext.tenantId ?? requestedTenantId;
}
function normalizeHistoryInput(messages, system) {
    if (messages.length === 0) {
        return {
            messages: [],
            ...(system !== undefined ? { system } : {}),
        };
    }
    const [firstMessage, ...rest] = messages;
    if (firstMessage?.role === 'system' &&
        typeof firstMessage.content === 'string' &&
        system === undefined) {
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
function snapshotToMessages(snapshot) {
    return snapshot.system
        ? [{ content: snapshot.system, pinned: true, role: 'system' }, ...snapshot.messages.map(cloneMessage)]
        : snapshot.messages.map(cloneMessage);
}
function splitHistoryForSnapshot(messages) {
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
function cloneSnapshot(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
}
function cloneMessage(message) {
    return JSON.parse(JSON.stringify(message));
}
function createSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function requireRouteSessionId(route) {
    if (!route.sessionId) {
        throw new HttpError(500, `Route ${route.path} is missing a session id.`);
    }
    return route.sessionId;
}
function stripSystemFromSnapshot(snapshot) {
    const next = cloneSnapshot(snapshot);
    delete next.system;
    return next;
}
function serializeStreamError(error) {
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
function formatSseEvent(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function jsonResponse(body, status = 200) {
    return Response.json(body, {
        headers: {
            'content-type': 'application/json',
        },
        status,
    });
}
function errorToResponse(error) {
    if (error instanceof HttpError) {
        return jsonResponse({
            error: {
                message: error.message,
                name: error.name,
            },
        }, error.status);
    }
    if (error instanceof LLMError) {
        return jsonResponse({
            error: {
                details: error.details,
                message: error.message,
                name: error.name,
                provider: error.provider,
                statusCode: error.statusCode,
            },
        }, error.statusCode ?? (error.retryable ? 503 : 500));
    }
    if (error instanceof Error) {
        return jsonResponse({
            error: {
                message: error.message,
                name: error.name,
            },
        }, 500);
    }
    return jsonResponse({
        error: {
            message: 'Unknown session API error.',
            name: 'Error',
        },
    }, 500);
}
