import type { ModelRegistry } from './models/registry.js';
import type { CanonicalMessage, CanonicalProvider, CanonicalTool, CanonicalToolChoice } from './types.js';
export interface RouterContext {
    maxTokens: number;
    messages: CanonicalMessage[];
    requestedModel?: string;
    requestedProvider?: CanonicalProvider;
    sessionId?: string;
    system?: string;
    temperature?: number;
    tenantId?: string;
    toolChoice?: CanonicalToolChoice;
    tools?: CanonicalTool[];
}
export interface ModelRouteTarget {
    model: string;
    name?: string;
    provider?: CanonicalProvider;
}
export interface WeightedRouteVariant extends ModelRouteTarget {
    weight: number;
}
export interface RouterContextFilter {
    hasTools?: boolean;
    model?: string;
    provider?: CanonicalProvider;
    sessionId?: string;
    tenantId?: string;
}
export type RouterMatch = RouterContextFilter | ((context: RouterContext) => boolean);
export interface ModelRouteRule {
    fallback?: Array<ModelRouteTarget | string>;
    match?: RouterMatch;
    name?: string;
    target?: ModelRouteTarget | string;
    variants?: WeightedRouteVariant[];
}
export interface ModelRouterOptions {
    rules?: ModelRouteRule[];
    seed?: string;
}
export interface ModelRouterResolveOptions {
    defaultModel?: string;
    defaultProvider?: CanonicalProvider;
    modelRegistry: ModelRegistry;
}
export interface ResolvedRouteAttempt {
    decision: string;
    model: string;
    provider?: CanonicalProvider;
}
export interface ResolvedModelRoute {
    attempts: ResolvedRouteAttempt[];
    decision: string;
    ruleName?: string;
}
export declare class ModelRouter {
    private readonly rules;
    private readonly seed;
    constructor(options?: ModelRouterOptions);
    resolve(context: RouterContext, options: ModelRouterResolveOptions): ResolvedModelRoute;
}
//# sourceMappingURL=router.d.ts.map