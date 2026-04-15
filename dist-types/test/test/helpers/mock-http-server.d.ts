import { type IncomingHttpHeaders } from 'node:http';
export interface MockHttpRequest {
    bodyText: string;
    headers: IncomingHttpHeaders;
    json: unknown;
    method: string;
    pathname: string;
    query: URLSearchParams;
    url: string;
}
export interface MockHttpResponse {
    body?: string;
    headers?: Record<string, string>;
    json?: unknown;
    sseEvents?: Array<string | unknown>;
    status?: number;
}
export interface MockHttpServer {
    baseUrl: string;
    close: () => Promise<void>;
    requests: MockHttpRequest[];
}
export declare function jsonResponse(json: unknown, init?: Omit<MockHttpResponse, 'json'>): MockHttpResponse;
export declare function sseResponse(sseEvents: Array<string | unknown>, init?: Omit<MockHttpResponse, 'sseEvents'>): MockHttpResponse;
export declare function startMockHttpServer(handler: (request: MockHttpRequest) => MockHttpResponse | Promise<MockHttpResponse>): Promise<MockHttpServer>;
//# sourceMappingURL=mock-http-server.d.ts.map