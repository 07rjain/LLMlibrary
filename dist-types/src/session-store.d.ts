import type { CanonicalProvider } from './types.js';
/** Metadata stored alongside a session snapshot. */
export interface SessionMeta {
    createdAt: string;
    messageCount: number;
    model?: string;
    provider?: CanonicalProvider;
    sessionId: string;
    tenantId?: string;
    totalCostUSD: number;
    updatedAt: string;
}
/** Serialized session record returned by a `SessionStore`. */
export interface SessionRecord<TSnapshot = unknown> {
    meta: SessionMeta;
    snapshot: TSnapshot;
}
/** Filter options for `SessionStore.list()`. */
export interface SessionStoreListOptions {
    tenantId?: string;
}
/** Write metadata for `SessionStore.set()`. */
export interface SessionStoreSetOptions {
    createdAt?: string;
    model?: string;
    provider?: CanonicalProvider;
    tenantId?: string;
}
/** Contract for durable conversation persistence backends. */
export interface SessionStore<TSnapshot = unknown> {
    delete(sessionId: string, tenantId?: string): Promise<void>;
    get(sessionId: string, tenantId?: string): Promise<null | SessionRecord<TSnapshot>>;
    list(options?: SessionStoreListOptions): Promise<SessionMeta[]>;
    set(sessionId: string, snapshot: TSnapshot, options?: SessionStoreSetOptions): Promise<SessionRecord<TSnapshot>>;
}
/** Row shape returned by the Postgres session store. */
export interface PostgresSessionStoreRow<TSnapshot> {
    created_at: Date | string;
    message_count: number;
    model: null | string;
    provider: CanonicalProvider | null;
    session_id: string;
    snapshot: TSnapshot;
    tenant_id: string;
    total_cost_usd: number | string;
    updated_at: Date | string;
}
/** Minimal query result contract used by Postgres-backed stores/loggers. */
export interface PostgresSessionStoreQueryResult<TRow = Record<string, unknown>> {
    rowCount?: null | number;
    rows: TRow[];
}
/** Minimal Postgres pool contract used by the session store. */
export interface PostgresSessionStorePool {
    end?: () => Promise<void>;
    query: <TRow = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<PostgresSessionStoreQueryResult<TRow>>;
}
/** Configuration for `PostgresSessionStore`. */
export interface PostgresSessionStoreOptions {
    connectionString?: string;
    now?: () => Date;
    pool?: PostgresSessionStorePool;
    schemaName?: string;
    tableName?: string;
}
/** Redis scan options consumed by `RedisSessionStore`. */
export interface RedisScanIteratorOptions {
    COUNT?: number;
    MATCH?: string;
}
/** Minimal Redis client contract required by `RedisSessionStore`. */
export interface RedisSessionStoreClient {
    del(key: string): Promise<number>;
    get(key: string): Promise<null | string>;
    keys?(pattern: string): Promise<string[]>;
    scanIterator?(options?: RedisScanIteratorOptions): AsyncIterable<string>;
    set(key: string, value: string, options?: {
        EX?: number;
    } | {
        expiration?: {
            type: 'EX';
            value: number;
        };
    }): Promise<unknown>;
}
/** Configuration for `RedisSessionStore`. */
export interface RedisSessionStoreOptions {
    client: RedisSessionStoreClient;
    keyPrefix?: string;
    now?: () => Date;
    scanCount?: number;
    ttlSeconds?: number;
}
/** Simple in-process store intended for tests and single-process development. */
export declare class InMemorySessionStore<TSnapshot extends {
    messages: unknown[];
    totalCostUSD: number;
}> implements SessionStore<TSnapshot> {
    private readonly now;
    private readonly records;
    constructor(options?: {
        now?: () => Date;
    });
    delete(sessionId: string, tenantId?: string): Promise<void>;
    get(sessionId: string, tenantId?: string): Promise<null | SessionRecord<TSnapshot>>;
    list(options?: SessionStoreListOptions): Promise<SessionMeta[]>;
    set(sessionId: string, snapshot: TSnapshot, options?: SessionStoreSetOptions): Promise<SessionRecord<TSnapshot>>;
}
/**
 * Postgres-backed durable session store with tenant scoping and indexed lookup.
 *
 * @example
 * ```ts
 * const store = PostgresSessionStore.fromEnv();
 * await store.ensureSchema();
 * ```
 */
export declare class PostgresSessionStore<TSnapshot extends {
    messages: unknown[];
    totalCostUSD: number;
}> implements SessionStore<TSnapshot> {
    private readonly connectionString;
    private ensureSchemaPromise;
    private internalPool;
    private readonly now;
    private readonly pool;
    private readonly schemaName;
    private readonly tableName;
    constructor(options?: PostgresSessionStoreOptions);
    static fromEnv<TSnapshot extends {
        messages: unknown[];
        totalCostUSD: number;
    }>(options?: Omit<PostgresSessionStoreOptions, 'connectionString'>): PostgresSessionStore<TSnapshot>;
    close(): Promise<void>;
    delete(sessionId: string, tenantId?: string): Promise<void>;
    get(sessionId: string, tenantId?: string): Promise<null | SessionRecord<TSnapshot>>;
    list(options?: SessionStoreListOptions): Promise<SessionMeta[]>;
    set(sessionId: string, snapshot: TSnapshot, options?: SessionStoreSetOptions): Promise<SessionRecord<TSnapshot>>;
    ensureSchema(): Promise<void>;
    private qualifiedTableName;
    private getPool;
    private runEnsureSchema;
}
/**
 * Redis-backed session store with optional TTL-based expiration.
 *
 * @example
 * ```ts
 * const store = new RedisSessionStore({
 *   client: redis,
 *   ttlSeconds: 3600,
 * });
 * ```
 */
export declare class RedisSessionStore<TSnapshot extends {
    messages: unknown[];
    totalCostUSD: number;
}> implements SessionStore<TSnapshot> {
    private readonly client;
    private readonly keyPrefix;
    private readonly now;
    private readonly scanCount;
    private readonly ttlSeconds;
    constructor(options: RedisSessionStoreOptions);
    delete(sessionId: string, tenantId?: string): Promise<void>;
    get(sessionId: string, tenantId?: string): Promise<null | SessionRecord<TSnapshot>>;
    list(options?: SessionStoreListOptions): Promise<SessionMeta[]>;
    set(sessionId: string, snapshot: TSnapshot, options?: SessionStoreSetOptions): Promise<SessionRecord<TSnapshot>>;
    private key;
    private iterateKeys;
}
//# sourceMappingURL=session-store.d.ts.map