import { createServer, } from 'node:http';
import { once } from 'node:events';
export function jsonResponse(json, init = {}) {
    return {
        ...init,
        json,
    };
}
export function sseResponse(sseEvents, init = {}) {
    return {
        ...init,
        sseEvents,
    };
}
export async function startMockHttpServer(handler) {
    const requests = [];
    const server = createServer(async (request, response) => {
        const bodyText = await readBody(request);
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const normalizedRequest = {
            bodyText,
            headers: request.headers,
            json: parseJson(bodyText),
            method: request.method ?? 'GET',
            pathname: url.pathname,
            query: url.searchParams,
            url: url.toString(),
        };
        requests.push(normalizedRequest);
        const resolved = await handler(normalizedRequest);
        const status = resolved.status ?? 200;
        if (resolved.sseEvents) {
            response.writeHead(status, {
                'content-type': 'text/event-stream',
                ...resolved.headers,
            });
            for (const event of resolved.sseEvents) {
                const payload = typeof event === 'string' ? event : JSON.stringify(event);
                response.write(`data: ${payload}\n\n`);
            }
            response.end();
            return;
        }
        if (resolved.json !== undefined) {
            response.writeHead(status, {
                'content-type': 'application/json',
                ...resolved.headers,
            });
            response.end(JSON.stringify(resolved.json));
            return;
        }
        response.writeHead(status, resolved.headers);
        response.end(resolved.body ?? '');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Mock HTTP server did not expose a TCP port.');
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
            if (!server.listening) {
                return;
            }
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
        requests,
    };
}
async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}
function parseJson(bodyText) {
    if (bodyText.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(bodyText);
    }
    catch {
        return undefined;
    }
}
