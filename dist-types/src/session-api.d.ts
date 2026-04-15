import { type ContextManager } from './context-manager.js';
import type { LLMClient } from './client.js';
import type { ConversationSnapshot } from './conversation.js';
import type { SessionMeta, SessionRecord, SessionStore } from './session-store.js';
import type { CanonicalMessage, CanonicalProvider, CanonicalTool, CanonicalToolChoice } from './types.js';
import type { UsageSummary } from './usage.js';
type MaybePromise<TValue> = Promise<TValue> | TValue;
/** Request-scoped metadata passed through session API middleware and handlers. */
export interface SessionApiRequestContext {
    tenantId?: string;
    [key: string]: unknown;
}
/** Middleware hook for auth, tenancy, and request enrichment. */
export type SessionApiMiddleware = (request: Request, context: SessionApiRequestContext) => MaybePromise<Partial<SessionApiRequestContext> | Response | void>;
/** Configuration for `SessionApi` and `createSessionApi()`. */
export interface SessionApiOptions {
    basePath?: string;
    client: LLMClient;
    conversationDefaults?: SessionConversationConfig;
    contextManager?: ContextManager;
    middleware?: SessionApiMiddleware[];
    sessionStore?: SessionStore<ConversationSnapshot>;
    tools?: CanonicalTool[];
    withRequestContext?: <TValue>(context: SessionApiRequestContext, execute: () => Promise<TValue>) => Promise<TValue>;
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
export declare class SessionApi {
    private readonly basePath;
    private readonly client;
    private readonly contextManager;
    private readonly conversationDefaults;
    private readonly middleware;
    private readonly sessionStore;
    private readonly tools;
    private readonly withRequestContext;
    constructor(options: SessionApiOptions);
    handle(request: Request): Promise<Response>;
    private dispatch;
    private handleCreateSession;
    private handleSendMessage;
    private handleGetSession;
    private handleGetSessionMessages;
    private handleDeleteSession;
    private handleCompactSession;
    private handleForkSession;
    private handleListSessions;
    private buildSessionView;
    private buildConversationOptions;
    private streamSessionMessage;
    private requireSession;
    private safeGetUsage;
    private applyMiddleware;
    private runWithRequestContext;
}
/** Creates a framework-agnostic session API instance. */
export declare function createSessionApi(options: SessionApiOptions): SessionApi;
export type { SessionMeta, SessionRecord, SessionStore };
//# sourceMappingURL=session-api.d.ts.map