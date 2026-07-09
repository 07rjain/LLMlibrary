import { describe, expect, it, vi } from 'vitest';

import { SlidingWindowStrategy } from '../src/context-manager.js';
import { LLMError, ProviderCapabilityError } from '../src/errors.js';
import { createSessionApi } from '../src/session-api.js';
import { InMemorySessionStore } from '../src/session-store.js';
import { LLMClient } from '../src/client.js';

import type { ConversationSnapshot } from '../src/conversation.js';
import type { SessionApiOptions } from '../src/session-api.js';
import type { JsonObject, StreamChunk } from '../src/types.js';

describe('SessionApi', () => {
  it('requires a session store and allows middleware to short-circuit requests', async () => {
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
    });

    expect(() =>
      createSessionApi({
        client,
      }),
    ).toThrow('SessionApi requires a session store');

    const shortCircuitApi = createSessionApi({
      client,
      middleware: [
        async () =>
          Response.json(
            {
              ok: false,
            },
            { status: 401 },
          ),
      ],
      sessionStore: new InMemorySessionStore<ConversationSnapshot>(),
    });
    const response = await shortCircuitApi.handle(
      new Request('https://example.test/sessions'),
    );

    expect(response.status).toBe(401);
  });

  it('supports create -> message -> inspect -> compact -> fork -> list -> delete', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>({
      now: () => new Date('2026-04-15T10:00:00.000Z'),
    });
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        mockResponse('First reply', 0.01),
      ],
      sessionStore: store,
    });
    vi.spyOn(client, 'getUsage').mockResolvedValue({
      breakdown: [
        {
          model: 'mock-model',
          provider: 'mock',
          requestCount: 1,
          totalCachedTokens: 0,
          totalCostUSD: 0.01,
          totalInputTokens: 4,
          totalOutputTokens: 2,
        },
      ],
      requestCount: 1,
      totalCachedTokens: 0,
      totalCostUSD: 0.01,
      totalInputTokens: 4,
      totalOutputTokens: 2,
    });
    const api = createSessionApi({
      allowClientOverrides: ['system'],
      client,
      contextManager: new SlidingWindowStrategy({ maxMessages: 2 }),
      sessionStore: store,
    });

    const createResponse = await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        messages: [{ content: 'Seed message', role: 'user' }],
        sessionId: 'session-1',
        system: 'Be brief.',
      }),
    );
    const created = (await createResponse.json()) as {
      session: {
        id: string;
        messages: unknown[];
      };
    };

    expect(createResponse.status).toBe(201);
    expect(created.session.id).toBe('session-1');
    expect(created.session.messages).toEqual([
      { content: 'Be brief.', pinned: true, role: 'system' },
      { content: 'Seed message', role: 'user' },
    ]);

    const messageResponse = await api.handle(
      jsonRequest('https://example.test/sessions/session-1/message?include=usage', 'POST', {
        content: 'Hello there',
      }),
    );
    const messaged = (await messageResponse.json()) as {
      response: { text: string };
      session: {
        messages: Array<{ content: unknown; role: string }>;
        totals: { costUSD: number; reasoningTokens: number };
        usage: { requestCount: number } | null;
      };
    };

    expect(messageResponse.status).toBe(200);
    expect(messaged.response.text).toBe('First reply');
    expect(messaged.session.totals.costUSD).toBe(0.01);
    expect(messaged.session.totals.reasoningTokens).toBe(1);
    expect(messaged.session.usage?.requestCount).toBe(1);
    expect(messaged.session.messages).toEqual([
      { content: 'Be brief.', pinned: true, role: 'system' },
      { content: 'Seed message', role: 'user' },
      { content: 'Hello there', role: 'user' },
      { content: 'First reply', role: 'assistant' },
    ]);

    const inspectResponse = await api.handle(
      new Request('https://example.test/sessions/session-1?include=messages,cost,usage'),
    );
    const inspected = (await inspectResponse.json()) as {
      session: {
        id: string;
        messages: Array<{ content: unknown; role: string }>;
        totals: { costUSD: number; reasoningTokens: number };
        usage: { requestCount: number } | null;
      };
    };

    expect(inspectResponse.status).toBe(200);
    expect(inspected.session.id).toBe('session-1');
    expect(inspected.session.totals.costUSD).toBe(0.01);
    expect(inspected.session.totals.reasoningTokens).toBe(1);
    expect(inspected.session.usage?.requestCount).toBe(1);
    expect(inspected.session.messages).toEqual(messaged.session.messages);

    const pagedMessagesResponse = await api.handle(
      new Request('https://example.test/sessions/session-1/messages?limit=2'),
    );
    const pagedMessages = (await pagedMessagesResponse.json()) as {
      messages: {
        items: Array<{ role: string }>;
        nextCursor?: string;
      };
    };

    expect(pagedMessages.messages.items).toHaveLength(2);
    expect(pagedMessages.messages.nextCursor).toBe('2');

    const compactResponse = await api.handle(
      jsonRequest('https://example.test/sessions/session-1/compact', 'POST', {
        maxMessages: 2,
      }),
    );
    const compacted = (await compactResponse.json()) as {
      compacted: boolean;
      removedCount: number;
      session: { messages: Array<{ role: string }> };
    };

    expect(compactResponse.status).toBe(200);
    expect(compacted.compacted).toBe(true);
    expect(compacted.removedCount).toBeGreaterThan(0);
    expect(compacted.session.messages).toEqual([
      { content: 'Be brief.', pinned: true, role: 'system' },
      { content: 'Hello there', role: 'user' },
      { content: 'First reply', role: 'assistant' },
    ]);

    const forkResponse = await api.handle(
      jsonRequest('https://example.test/sessions/session-1/fork', 'POST', {
        fromMessageIndex: 1,
        newSessionId: 'session-1-fork',
      }),
    );
    const forked = (await forkResponse.json()) as {
      resetUsage: boolean;
      session: {
        id: string;
        messages: Array<{ role: string }>;
        totals: { costUSD: number };
      };
    };

    expect(forkResponse.status).toBe(201);
    expect(forked.resetUsage).toBe(true);
    expect(forked.session.id).toBe('session-1-fork');
    expect(forked.session.totals.costUSD).toBe(0);
    expect(forked.session.messages).toEqual([
      { content: 'Be brief.', pinned: true, role: 'system' },
      { content: 'Hello there', role: 'user' },
    ]);

    const listResponse = await api.handle(
      new Request('https://example.test/sessions?limit=1'),
    );
    const listed = (await listResponse.json()) as {
      sessions: {
        items: Array<{ sessionId?: string; id?: string }>;
        nextCursor?: string;
      };
    };

    expect(listed.sessions.items).toHaveLength(1);
    expect(listed.sessions.nextCursor).toBe('1');

    const deleteResponse = await api.handle(
      new Request('https://example.test/sessions/session-1-fork', {
        method: 'DELETE',
      }),
    );
    const deleted = (await deleteResponse.json()) as { deleted: boolean };

    expect(deleteResponse.status).toBe(200);
    expect(deleted.deleted).toBe(true);
    await expect(store.get('session-1-fork')).resolves.toBeNull();
  });

  it('ignores responseFormat from session creation config unless allowlisted', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      sessionStore: store,
    });

    const response = await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        responseFormat: {
          schema: {
            properties: {
              answer: { type: 'string' },
            },
            type: 'object',
          },
          type: 'json_schema',
        },
        sessionId: 'structured-session',
      }),
    );

    expect(response.status).toBe(201);
    const record = await store.get('structured-session');
    expect(record?.snapshot.responseFormat).toBeUndefined();

    const trustedStore = new InMemorySessionStore<ConversationSnapshot>();
    const trustedClient = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: trustedStore,
    });
    const trustedApi = createSessionApi({
      allowClientOverrides: ['responseFormat'],
      client: trustedClient,
      sessionStore: trustedStore,
    });
    const trustedResponse = await trustedApi.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        responseFormat: {
          schema: {
            properties: {
              answer: { type: 'string' },
            },
            type: 'object',
          },
          type: 'json_schema',
        },
        sessionId: 'trusted-structured-session',
      }),
    );
    const trustedRecord = await trustedStore.get('trusted-structured-session');

    expect(trustedResponse.status).toBe(201);
    expect(trustedRecord?.snapshot.responseFormat).toMatchObject({
      schema: {
        properties: {
          answer: { type: 'string' },
        },
        type: 'object',
      },
      type: 'json_schema',
    });
  });

  it('ignores client system prompts on session creation unless allowlisted', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      conversationDefaults: {
        system: 'SERVER_SYSTEM_PROMPT',
      },
      sessionStore: store,
    });

    const response = await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        messages: [
          { content: 'ATTACKER_SYSTEM', role: 'system' },
          { content: 'Hello', role: 'user' },
        ],
        sessionId: 'system-denied-session',
        system: 'ATTACKER_BODY_SYSTEM',
      }),
    );
    const record = await store.get('system-denied-session');

    expect(response.status).toBe(201);
    expect(record?.snapshot.system).toBe('SERVER_SYSTEM_PROMPT');
    expect(record?.snapshot.messages).toEqual([{ content: 'Hello', role: 'user' }]);

    const trustedStore = new InMemorySessionStore<ConversationSnapshot>();
    const trustedClient = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: trustedStore,
    });
    const trustedApi = createSessionApi({
      allowClientOverrides: ['system'],
      client: trustedClient,
      conversationDefaults: {
        system: 'SERVER_SYSTEM_PROMPT',
      },
      sessionStore: trustedStore,
    });

    const trustedResponse = await trustedApi.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        messages: [
          { content: 'ALLOWLISTED_SYSTEM', role: 'system' },
          { content: 'Hello', role: 'user' },
        ],
        sessionId: 'system-allowed-session',
      }),
    );
    const trustedRecord = await trustedStore.get('system-allowed-session');

    expect(trustedResponse.status).toBe(201);
    expect(trustedRecord?.snapshot.system).toBe('ALLOWLISTED_SYSTEM');
  });

  it('streams canonical SSE events for session messages', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
      streams: [
        [
          { delta: 'Hello ', type: 'text-delta' },
          { id: 'tool_1', name: 'lookup', type: 'tool-call-start' },
          { argsDelta: '{"city":"Berlin"}', id: 'tool_1', type: 'tool-call-delta' },
          {
            id: 'tool_1',
            name: 'lookup',
            result: { city: 'Berlin', secret: 'raw-tool-secret' },
            type: 'tool-call-result',
          },
          {
            finishReason: 'stop',
            type: 'done',
            usage: {
              cachedTokens: 0,
              cost: '$0.01',
              costUSD: 0.01,
              inputTokens: 4,
              outputTokens: 2,
            },
          },
        ],
      ],
    });
    const api = createSessionApi({
      client,
      sessionStore: store,
    });

    await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'stream-session',
        system: 'Be concise.',
      }),
    );

    const response = await api.handle(
      jsonRequest('https://example.test/sessions/stream-session/message?stream=true', 'POST', {
        content: 'Stream this',
        stream: true,
      }),
    );
    const text = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: session.message.started');
    expect(text).toContain('event: response.text.delta');
    expect(text).toContain('event: response.tool_call.start');
    expect(text).toContain('event: response.tool_call.delta');
    expect(text).toContain('event: response.tool_call.result');
    expect(text).toContain('[tool result withheld]');
    expect(text).toContain('"redacted":true');
    expect(text).not.toContain('raw-tool-secret');
    expect(text).toContain('event: response.completed');
  });

  it('aborts streamed session work when the request signal is aborted', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    let observedSignal: AbortSignal | undefined;
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
      streams: [
        async function* (options): AsyncGenerator<StreamChunk, void, void> {
          observedSignal = options.signal;
          yield { delta: 'first', type: 'text-delta' };
          await new Promise<void>((_, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                resolveAbort?.();
                reject(options.signal?.reason ?? new Error('aborted'));
              },
              { once: true },
            );
          });
        },
      ],
    });
    const api = createSessionApi({
      client,
      sessionStore: store,
    });

    await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'abort-stream-session',
      }),
    );

    const abortController = new AbortController();
    const response = await api.handle(
      new Request('https://example.test/sessions/abort-stream-session/message?stream=true', {
        body: JSON.stringify({ content: 'Stream this', stream: true }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: abortController.signal,
      }),
    );

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.read();
    abortController.abort(new Error('client disconnected'));
    await aborted;
    await reader?.cancel();

    expect(observedSignal?.aborted).toBe(true);
  });

  it('redacts tool result messages in JSON projections unless explicitly exposed', async () => {
    const usage = {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: 1,
      outputTokens: 1,
    };
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        {
          content: [],
          finishReason: 'tool_call',
          model: 'mock-model',
          provider: 'mock',
          raw: {},
          text: '',
          toolCalls: [{ args: {}, id: 'tool_1', name: 'secret_tool' }],
          usage,
        },
        mockResponse('done', 0.01),
      ],
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      sessionStore: store,
      tools: [
        {
          description: 'Returns a secret payload',
          execute: async () => ({ secret: 'raw-tool-secret' }),
          name: 'secret_tool',
          parameters: { properties: {}, type: 'object' },
        },
      ],
    });

    await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'redacted-tool-session',
      }),
    );
    const response = await api.handle(
      jsonRequest('https://example.test/sessions/redacted-tool-session/message', 'POST', {
        content: 'run tool',
      }),
    );
    const payloadText = await response.text();

    expect(response.status).toBe(200);
    expect(payloadText).toContain('[tool result withheld]');
    expect(payloadText).toContain('"redacted":true');
    expect(payloadText).not.toContain('raw-tool-secret');

    const exposedStore = new InMemorySessionStore<ConversationSnapshot>();
    const exposedClient = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        {
          content: [],
          finishReason: 'tool_call',
          model: 'mock-model',
          provider: 'mock',
          raw: {},
          text: '',
          toolCalls: [{ args: {}, id: 'tool_1', name: 'secret_tool' }],
          usage,
        },
        mockResponse('done', 0.01),
      ],
      sessionStore: exposedStore,
    });
    const exposedApi = createSessionApi({
      client: exposedClient,
      exposeToolResults: true,
      sessionStore: exposedStore,
      tools: [
        {
          description: 'Returns a secret payload',
          execute: async () => ({ secret: 'raw-tool-secret' }),
          name: 'secret_tool',
          parameters: { properties: {}, type: 'object' },
        },
      ],
    });

    await exposedApi.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'exposed-tool-session',
      }),
    );
    const exposedResponse = await exposedApi.handle(
      jsonRequest('https://example.test/sessions/exposed-tool-session/message', 'POST', {
        content: 'run tool',
      }),
    );

    expect(exposedResponse.status).toBe(200);
    await expect(exposedResponse.text()).resolves.toContain('raw-tool-secret');
  });

  it('supports tenant middleware and request-context wrappers for session operations', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const withRequestContextSpy = vi.fn();
    const withRequestContext: SessionApiOptions['withRequestContext'] = async (
      context,
      execute,
    ) => {
      withRequestContextSpy(context);
      return execute();
    };
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      middleware: [
        async (request) => {
          const tenantId = request.headers.get('x-tenant-id') ?? undefined;
          return tenantId ? { tenantId } : {};
        },
      ],
      sessionStore: store,
      withRequestContext,
    });

    const spoofedResponse = await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'tenant-session',
        tenantId: 'spoofed',
      }, {
        'x-tenant-id': 'tenant-a',
      }),
    );
    const response = await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'tenant-session',
      }, {
        'x-tenant-id': 'tenant-a',
      }),
    );

    expect(spoofedResponse.status).toBe(400);
    expect(response.status).toBe(201);
    expect(withRequestContextSpy).toHaveBeenCalled();
    await expect(store.get('tenant-session', 'tenant-a')).resolves.not.toBeNull();
    await expect(store.get('tenant-session', 'spoofed')).resolves.toBeNull();
  });

  it('rejects request-supplied tenant ids on every tenant-aware route by default', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [mockResponse('reply', 0.01)],
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      middleware: [
        async () => ({
          tenantId: 'tenant-a',
        }),
      ],
      sessionStore: store,
    });

    const createResponse = await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'tenant-routes',
      }),
    );

    expect(createResponse.status).toBe(201);

    const responses = await Promise.all([
      api.handle(
        jsonRequest('https://example.test/sessions', 'POST', {
          sessionId: 'spoofed-create',
          tenantId: 'tenant-b',
        }),
      ),
      api.handle(
        jsonRequest('https://example.test/sessions/tenant-routes/message', 'POST', {
          content: 'hello',
          tenantId: 'tenant-b',
        }),
      ),
      api.handle(new Request('https://example.test/sessions/tenant-routes?tenantId=tenant-b')),
      api.handle(
        new Request('https://example.test/sessions/tenant-routes/messages?tenantId=tenant-b'),
      ),
      api.handle(
        new Request('https://example.test/sessions/tenant-routes?tenantId=tenant-b', {
          method: 'DELETE',
        }),
      ),
      api.handle(
        jsonRequest('https://example.test/sessions/tenant-routes/compact', 'POST', {
          maxMessages: 1,
          tenantId: 'tenant-b',
        }),
      ),
      api.handle(
        jsonRequest('https://example.test/sessions/tenant-routes/fork', 'POST', {
          fromMessageIndex: 0,
          tenantId: 'tenant-b',
        }),
      ),
      api.handle(new Request('https://example.test/sessions?tenantId=tenant-b')),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400, 400, 400, 400,
    ]);
  });

  it('allows request-supplied tenant ids only in explicit legacy mode', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      sessionStore: store,
      tenantResolution: 'legacy-request-tenant',
    });

    const createResponse = await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        messages: [{ content: 'legacy secret', role: 'user' }],
        sessionId: 'legacy-session',
        tenantId: 'tenant-a',
      }),
    );
    const getResponse = await api.handle(
      new Request('https://example.test/sessions/legacy-session?tenantId=tenant-a'),
    );

    expect(createResponse.status).toBe(201);
    expect(getResponse.status).toBe(200);
  });

  it('ignores toolValidation from session message config unless allowlisted', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const execute = vi.fn(async (args: JsonObject) => ({ observed: String(args.count) }));
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        {
          content: [
            {
              args: { count: 'not-number', extra: 'allowed only in permissive mode' },
              id: 'tool_1',
              name: 'validated_tool',
              type: 'tool_call',
            },
          ],
          finishReason: 'tool_call',
          model: 'mock-model',
          provider: 'mock',
          raw: {},
          text: '',
          toolCalls: [
            {
              args: { count: 'not-number', extra: 'allowed only in permissive mode' },
              id: 'tool_1',
              name: 'validated_tool',
            },
          ],
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 1,
            outputTokens: 1,
          },
        },
        mockResponse('done', 0.01),
      ],
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      conversationDefaults: {
        toolValidation: 'strict',
      },
      sessionStore: store,
      tools: [
        {
          description: 'Validated tool',
          execute,
          name: 'validated_tool',
          parameters: {
            properties: {
              count: { type: 'number' },
            },
            type: 'object',
          },
        },
      ],
    });

    await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'tool-validation-session',
      }),
    );
    const response = await api.handle(
      jsonRequest('https://example.test/sessions/tool-validation-session/message', 'POST', {
        content: 'run',
        toolValidation: 'permissive',
      }),
    );

    expect(response.status).toBe(200);
    expect(execute).not.toHaveBeenCalled();

    const trustedStore = new InMemorySessionStore<ConversationSnapshot>();
    const trustedExecute = vi.fn(async (args: JsonObject) => ({
      observed: String(args.count),
    }));
    const trustedClient = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        {
          content: [
            {
              args: { count: 'not-number', extra: 'allowed only in permissive mode' },
              id: 'tool_1',
              name: 'validated_tool',
              type: 'tool_call',
            },
          ],
          finishReason: 'tool_call',
          model: 'mock-model',
          provider: 'mock',
          raw: {},
          text: '',
          toolCalls: [
            {
              args: { count: 'not-number', extra: 'allowed only in permissive mode' },
              id: 'tool_1',
              name: 'validated_tool',
            },
          ],
          usage: {
            cachedTokens: 0,
            cost: '$0.00',
            costUSD: 0,
            inputTokens: 1,
            outputTokens: 1,
          },
        },
        mockResponse('done', 0.01),
      ],
      sessionStore: trustedStore,
    });
    const trustedApi = createSessionApi({
      allowClientOverrides: ['toolValidation'],
      client: trustedClient,
      conversationDefaults: {
        toolValidation: 'strict',
      },
      sessionStore: trustedStore,
      tools: [
        {
          description: 'Validated tool',
          execute: trustedExecute,
          name: 'validated_tool',
          parameters: {
            properties: {
              count: { type: 'number' },
            },
            type: 'object',
          },
        },
      ],
    });

    await trustedApi.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'trusted-tool-validation-session',
      }),
    );
    const trustedResponse = await trustedApi.handle(
      jsonRequest(
        'https://example.test/sessions/trusted-tool-validation-session/message',
        'POST',
        {
          content: 'run',
          toolValidation: 'permissive',
        },
      ),
    );

    expect(trustedResponse.status).toBe(200);
    expect(trustedExecute).toHaveBeenCalledWith(
      { count: 'not-number', extra: 'allowed only in permissive mode' },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('enforces cross-tenant isolation across get, message, and delete operations', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [mockResponse('Tenant A reply', 0.02)],
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      middleware: [
        async (request) => {
          const tenantId = request.headers.get('x-tenant-id') ?? undefined;
          return tenantId ? { tenantId } : {};
        },
      ],
      sessionStore: store,
    });

    const createResponse = await api.handle(
      jsonRequest(
        'https://example.test/sessions',
        'POST',
        {
          sessionId: 'shared-session',
          system: 'Tenant scoped.',
        },
        {
          'x-tenant-id': 'tenant-a',
        },
      ),
    );

    expect(createResponse.status).toBe(201);

    const getOtherTenantResponse = await api.handle(
      new Request('https://example.test/sessions/shared-session', {
        headers: {
          'x-tenant-id': 'tenant-b',
        },
      }),
    );
    const messageOtherTenantResponse = await api.handle(
      jsonRequest(
        'https://example.test/sessions/shared-session/message',
        'POST',
        {
          content: 'Should not see this session',
        },
        {
          'x-tenant-id': 'tenant-b',
        },
      ),
    );
    const tenantAVisibleResponse = await api.handle(
      new Request('https://example.test/sessions/shared-session', {
        headers: {
          'x-tenant-id': 'tenant-a',
        },
      }),
    );
    const tenantBVisibleResponse = await api.handle(
      new Request('https://example.test/sessions/shared-session', {
        headers: {
          'x-tenant-id': 'tenant-b',
        },
      }),
    );
    const tenantBPayload = (await tenantBVisibleResponse.json()) as {
      session: { messages: Array<{ content: unknown; role: string }> };
    };
    const deleteOtherTenantResponse = await api.handle(
      new Request('https://example.test/sessions/shared-session', {
        headers: {
          'x-tenant-id': 'tenant-b',
        },
        method: 'DELETE',
      }),
    );
    const tenantBDeletedResponse = await api.handle(
      new Request('https://example.test/sessions/shared-session', {
        headers: {
          'x-tenant-id': 'tenant-b',
        },
      }),
    );

    expect(getOtherTenantResponse.status).toBe(404);
    expect(messageOtherTenantResponse.status).toBe(200);
    expect(tenantAVisibleResponse.status).toBe(200);
    expect(tenantBVisibleResponse.status).toBe(200);
    expect(tenantBPayload.session.messages).toEqual([
      { content: 'Should not see this session', role: 'user' },
      { content: 'Tenant A reply', role: 'assistant' },
    ]);
    expect(deleteOtherTenantResponse.status).toBe(200);
    expect(tenantBDeletedResponse.status).toBe(404);
    await expect(store.get('shared-session', 'tenant-a')).resolves.not.toBeNull();
    await expect(store.get('shared-session', 'tenant-b')).resolves.toBeNull();
  });

  it('returns structured errors for bad JSON, bad fork requests, and unavailable usage aggregation', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
    });
    vi.spyOn(client, 'getUsage').mockRejectedValue(
      new ProviderCapabilityError('usage unavailable'),
    );
    const api = createSessionApi({
      client,
      sessionStore: store,
    });

    await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'error-session',
      }),
    );

    const badJsonResponse = await api.handle(
      new Request('https://example.test/sessions', {
        body: '{bad json',
        headers: {
          'content-type': 'application/json',
        },
        method: 'POST',
      }),
    );
    const badForkResponse = await api.handle(
      jsonRequest('https://example.test/sessions/error-session/fork', 'POST', {
        fromMessageIndex: 99,
      }),
    );
    const usageResponse = await api.handle(
      new Request('https://example.test/sessions/error-session?include=usage'),
    );
    const usagePayload = (await usageResponse.json()) as {
      session: { usage: null };
    };

    expect(badJsonResponse.status).toBe(400);
    expect(badForkResponse.status).toBe(400);
    expect(usagePayload.session.usage).toBeNull();
  });

  it('covers alternate create, list, compact, fork, and error-mapping branches', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        () => {
          throw new ProviderCapabilityError('forced llm error', {
            provider: 'mock',
            statusCode: 422,
          });
        },
      ],
      sessionStore: store,
    });
    const api = createSessionApi({
      basePath: 'v1/sessions',
      client,
      conversationDefaults: {
        budgetUsd: 1,
        maxContextTokens: 1234,
        maxTokens: 55,
        maxToolRounds: 4,
        model: 'mock-model',
        provider: 'mock',
        providerOptions: {
          openai: {
            reasoning: {
              effort: 'low',
              summary: 'auto',
            },
          },
        },
        system: 'Default system',
        toolChoice: { type: 'auto' },
        toolExecutionTimeoutMs: 999,
      },
      sessionStore: store,
      tools: [
        {
          description: 'Example tool',
          name: 'example_tool',
          parameters: {
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
            type: 'object',
          },
        },
      ],
    });

    const createResponse = await api.handle(
      jsonRequest('https://example.test/v1/sessions', 'POST', {
        messages: [
          { content: 'System from messages', role: 'system' },
          { content: 'History item', role: 'user' },
        ],
        providerOptions: {
          openai: {
            reasoning: {
              effort: 'medium',
              summary: 'detailed',
            },
          },
        },
      }),
    );
    const created = (await createResponse.json()) as {
      session: {
        id: string;
        system?: string;
      };
    };
    const createdRecord = await store.get(created.session.id);

    expect(createResponse.status).toBe(201);
    expect(createdRecord?.snapshot.system).toBe('Default system');
    expect(createdRecord?.snapshot.maxTokens).toBe(55);
    expect(createdRecord?.snapshot.maxToolRounds).toBe(4);
    expect(createdRecord?.snapshot.providerOptions).toEqual({
      openai: {
        reasoning: {
          effort: 'low',
          summary: 'auto',
        },
      },
    });
    expect(createdRecord?.snapshot.toolChoice).toEqual({ type: 'auto' });

    const listFilteredResponse = await api.handle(
      new Request('https://example.test/v1/sessions?model=other-model&provider=openai'),
    );
    const listFilteredPayload = (await listFilteredResponse.json()) as {
      sessions: { items: unknown[] };
    };

    expect(listFilteredPayload.sessions.items).toEqual([]);

    const notFoundRouteResponse = await api.handle(
      new Request('https://example.test/other'),
    );
    const methodNotAllowedResponse = await api.handle(
      new Request(`https://example.test/v1/sessions/${created.session.id}`, {
        method: 'POST',
      }),
    );
    const badCursorResponse = await api.handle(
      new Request('https://example.test/v1/sessions?cursor=-1'),
    );
    const badLimitResponse = await api.handle(
      new Request(`https://example.test/v1/sessions/${created.session.id}/messages?limit=101`),
    );
    const compactWithoutStrategyResponse = await createSessionApi({
      client,
      sessionStore: store,
    }).handle(
      jsonRequest(`https://example.test/sessions/${created.session.id}/compact`, 'POST', {}),
    );

    expect(notFoundRouteResponse.status).toBe(404);
    expect(methodNotAllowedResponse.status).toBe(405);
    expect(badCursorResponse.status).toBe(400);
    expect(badLimitResponse.status).toBe(400);
    expect(compactWithoutStrategyResponse.status).toBe(400);

    const messageErrorResponse = await api.handle(
      jsonRequest(`https://example.test/v1/sessions/${created.session.id}/message`, 'POST', {
        content: 'Trigger llm error',
      }),
    );
    const messageErrorPayload = (await messageErrorResponse.json()) as {
      error: { name: string };
    };

    expect(messageErrorResponse.status).toBe(422);
    expect(messageErrorPayload.error.name).toBe('ProviderCapabilityError');

    await store.set(
      'usage-preserved',
      {
        createdAt: '2026-04-15T10:00:00.000Z',
        messages: [{ content: 'Branch me', role: 'user' }],
        sessionId: 'usage-preserved',
        totalCachedTokens: 2,
        totalCostUSD: 0.25,
        totalInputTokens: 11,
        totalOutputTokens: 5,
        totalReasoningTokens: 3,
        updatedAt: '2026-04-15T10:00:00.000Z',
      },
      {},
    );

    const forkPreserveUsageResponse = await api.handle(
      jsonRequest('https://example.test/v1/sessions/usage-preserved/fork', 'POST', {
        fromMessageIndex: 0,
        resetUsage: false,
      }),
    );
    const forkPreserveUsagePayload = (await forkPreserveUsageResponse.json()) as {
      session: { totals: { costUSD: number; reasoningTokens: number } };
    };

    expect(forkPreserveUsageResponse.status).toBe(201);
    expect(forkPreserveUsagePayload.session.totals.costUSD).toBe(0.25);
    expect(forkPreserveUsagePayload.session.totals.reasoningTokens).toBe(3);

    const missingDeleteResponse = await api.handle(
      new Request('https://example.test/v1/sessions/missing', {
        method: 'DELETE',
      }),
    );

    expect(missingDeleteResponse.status).toBe(404);
  });

  it('maps unknown and generic errors to 500 responses', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      sessionStore: store,
    });

    const unknownErrorApi = createSessionApi({
      client,
      middleware: [
        async () => {
          throw 'unknown failure';
        },
      ],
      sessionStore: store,
    });
    const errorApi = createSessionApi({
      client,
      sessionStore: store,
    });
    vi.spyOn(client, 'getUsage').mockRejectedValueOnce(new Error('usage blew up'));

    await errorApi.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'usage-error-session',
      }),
    );

    const unknownErrorResponse = await unknownErrorApi.handle(
      new Request('https://example.test/sessions'),
    );
    const genericErrorResponse = await errorApi.handle(
      new Request('https://example.test/sessions/usage-error-session?include=usage'),
    );
    const unknownPayload = (await unknownErrorResponse.json()) as {
      error: { message: string };
    };
    const genericPayload = (await genericErrorResponse.json()) as {
      error: { message: string; name: string };
    };

    expect(unknownErrorResponse.status).toBe(500);
    expect(unknownPayload.error.message).toBe('Unknown session API error.');
    expect(genericErrorResponse.status).toBe(500);
    expect(genericPayload.error.name).toBe('Error');
    expect(genericPayload.error.message).toBe('Internal session API error.');
  });

  it('redacts LLM error messages and details from external responses', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.mock({
      defaultModel: 'mock-model',
      defaultProvider: 'mock',
      responses: [
        async () => {
          throw new LLMError('Bearer sk-secret123456789 leaked', {
            details: {
              apiKey: 'sk-secret123456789',
              databaseUrl: 'postgres://user:pass@example.test/db',
              nested: {
                authorization: 'Bearer sk-secret123456789',
              },
            },
            provider: 'openai',
            statusCode: 500,
          });
        },
      ],
      sessionStore: store,
    });
    const api = createSessionApi({
      client,
      sessionStore: store,
    });

    await api.handle(
      jsonRequest('https://example.test/sessions', 'POST', {
        sessionId: 'error-session',
      }),
    );
    const response = await api.handle(
      jsonRequest('https://example.test/sessions/error-session/message', 'POST', {
        content: 'trigger',
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain('sk-secret123456789');
    expect(body).not.toContain('postgres://user:pass');
    expect(body).not.toContain('authorization');
    expect(body).toContain('LLM provider request failed.');
  });
});

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    method,
  });
}

function mockResponse(text: string, costUSD: number) {
  return {
    content: text.length > 0 ? [{ text, type: 'text' as const }] : [],
    finishReason: 'stop' as const,
    model: 'mock-model',
    provider: 'mock' as const,
    raw: {},
    text,
    toolCalls: [],
    usage: {
      cachedTokens: 0,
      cost: `$${costUSD.toFixed(2)}`,
      costUSD,
      inputTokens: 4,
      outputTokens: 2,
      reasoningTokens: 1,
    },
  };
}
