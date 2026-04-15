import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import { once } from 'node:events';

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

export function jsonResponse(
  json: unknown,
  init: Omit<MockHttpResponse, 'json'> = {},
): MockHttpResponse {
  return {
    ...init,
    json,
  };
}

export function sseResponse(
  sseEvents: Array<string | unknown>,
  init: Omit<MockHttpResponse, 'sseEvents'> = {},
): MockHttpResponse {
  return {
    ...init,
    sseEvents,
  };
}

export async function startMockHttpServer(
  handler: (request: MockHttpRequest) => MockHttpResponse | Promise<MockHttpResponse>,
): Promise<MockHttpServer> {
  const requests: MockHttpRequest[] = [];
  const server = createServer(async (request, response) => {
    const bodyText = await readBody(request);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const normalizedRequest: MockHttpRequest = {
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

      await new Promise<void>((resolve, reject) => {
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

async function readBody(
  request: IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(bodyText: string): unknown {
  if (bodyText.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}
