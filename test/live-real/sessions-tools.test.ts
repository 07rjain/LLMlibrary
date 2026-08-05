import { describe, expect, it } from 'vitest';

import { LLMClient } from '../../src/client.js';
import {
  Conversation,
  type ConversationSnapshot,
} from '../../src/conversation.js';
import {
  SlidingWindowStrategy,
  SummarisationStrategy,
} from '../../src/context-manager.js';
import { createSessionApi } from '../../src/session-api.js';
import { InMemorySessionStore } from '../../src/session-store.js';
import type { CanonicalMessage, CanonicalResponse } from '../../src/types.js';
import {
  assertCanonicalResponse,
  collectStream,
  liveClient,
  liveTemperature,
  liveRealEnabled,
  providerModels,
  requireLiveEnv,
  runId,
  weatherTool,
} from './helpers.js';

const liveDescribe = liveRealEnabled ? describe : describe.skip;

liveDescribe('live-real sessions, tools, and context', () => {
  it.each(['complete', 'stream'] as const)(
    'replays private Gemini thought signatures in an automatic %s tool loop',
    async (mode) => {
      requireLiveEnv('GEMINI_API_KEY');
      const evidence = {
        firstResponseSigned: false,
        providerCalls: 0,
        replaySigned: false,
        toolExecutions: 0,
      };
      const client = LLMClient.fromEnv({
        fetchImplementation: createRedactedGeminiFetchProbe(evidence),
        retryOptions: { maxAttempts: 1 },
      });
      const conversation = await client.conversation({
        maxTokens: 64,
        model:
          process.env.GEMINI_TOOL_LOOP_TEST_MODEL ?? 'gemini-3.1-flash-lite',
        provider: 'google',
        system:
          'Use add_numbers once. After the tool result, reply with GEMINI_LOOP_OK.',
        toolChoice: { name: 'add_numbers', type: 'tool' },
        tools: [
          {
            description: 'Add two integers.',
            execute: async (args) => {
              evidence.toolExecutions += 1;
              return {
                result: Number(args.a) + Number(args.b),
              };
            },
            name: 'add_numbers',
            parameters: {
              properties: {
                a: { type: 'integer' },
                b: { type: 'integer' },
              },
              required: ['a', 'b'],
              type: 'object',
            },
          },
        ],
      });

      let visible = '';
      let publicStreamJson = '';
      if (mode === 'complete') {
        visible = (await conversation.send('Add 3 and 4.')).text;
      } else {
        const chunks = [];
        for await (const chunk of conversation.sendStream('Add 3 and 4.')) {
          chunks.push(chunk);
          if (chunk.type === 'text-delta') {
            visible += chunk.delta;
          }
        }
        publicStreamJson = JSON.stringify(chunks);
      }

      expect(visible).toContain('GEMINI_LOOP_OK');
      expect(evidence).toEqual({
        firstResponseSigned: true,
        providerCalls: 2,
        replaySigned: true,
        toolExecutions: 1,
      });
      expect(conversation.totals.costUSD).toBeGreaterThan(0);
      expect(conversation.totals.costUSD).toBeLessThan(0.0002);
      console.info(
        JSON.stringify({
          costUSD: conversation.totals.costUSD,
          firstResponseSigned: evidence.firstResponseSigned,
          mode,
          model:
            process.env.GEMINI_TOOL_LOOP_TEST_MODEL ??
            'gemini-3.1-flash-lite',
          provider: 'google',
          providerCalls: evidence.providerCalls,
          replaySigned: evidence.replaySigned,
          toolExecutions: evidence.toolExecutions,
        }),
      );
      expect(publicStreamJson).not.toMatch(/thought_?signature/i);
      expect(JSON.stringify(conversation.history)).not.toMatch(
        /thought_?signature/i,
      );
    },
    180_000,
  );

  it('auto-executes tools inside Conversation and preserves history', async () => {
    requireLiveEnv('OPENAI_API_KEY');
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const sessionId = runId('conv_tool');
    const client = LLMClient.fromEnv({
      retryOptions: { maxAttempts: 2 },
      sessionStore: store,
    });
    const conversation = await client.conversation({
      maxTokens: 96,
      model: providerModels.openai,
      provider: 'openai',
      sessionId,
      system:
        'When weather is requested, use the tool. After receiving a tool result, answer with WEATHER_DONE and the city.',
      toolChoice: { name: 'get_weather', type: 'tool' },
      tools: [weatherTool()],
    });

    const response = await conversation.send('What is the weather in Paris?');
    assertCanonicalResponse(response, 'openai');
    expect(response.text).toContain('WEATHER_DONE');
    expect(conversation.history.some(messageHasToolResult)).toBe(true);
    expect(conversation.totals.inputTokens).toBeGreaterThan(0);
    expect(conversation.totals.outputTokens).toBeGreaterThan(0);
    expect(conversation.totals.reasoningTokens).toBeGreaterThanOrEqual(0);
    expect(conversation.totals.costUSD).toBeGreaterThan(0);

    const restored = await client.conversation({ sessionId });
    expect(restored.history.length).toBe(conversation.history.length);
    expect(restored.totals.costUSD).toBe(conversation.totals.costUSD);
  }, 360_000);

  it('streams inside Conversation and persists final usage', async () => {
    requireLiveEnv('OPENAI_API_KEY');
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const sessionId = runId('conv_stream');
    const client = LLMClient.fromEnv({
      retryOptions: { maxAttempts: 2 },
      sessionStore: store,
    });
    const conversation = await client.conversation({
      maxTokens: 24,
      model: providerModels.openai,
      provider: 'openai',
      sessionId,
    });

    const result = await collectStream(
      conversation.sendStream('Reply with exactly: CONVERSATION_STREAM_OK'),
    );
    expect(result.text).toContain('CONVERSATION_STREAM_OK');
    expect(result.done).toBeDefined();
    expect(conversation.history.length).toBe(2);
    expect(conversation.totals.costUSD).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('resolves implicit conversation routes before the real provider call', async () => {
    requireLiveEnv('OPENAI_API_KEY');
    const contexts: Array<{
      contextWindow?: number;
      model?: string;
      provider?: string;
      reservedOutputTokens?: number;
      toolRound?: number;
    }> = [];
    const client = LLMClient.fromEnv({
      defaultModel: providerModels.openai,
      defaultProvider: 'openai',
      retryOptions: { maxAttempts: 2 },
    });
    const conversation = await client.conversation({
      contextManager: {
        shouldTrim: (_messages, context) => {
          contexts.push(context);
          return false;
        },
        trim: (messages) => messages,
      },
      maxTokens: 32,
      sessionId: runId('implicit_context'),
    });

    const response = await conversation.send(
      'Reply with exactly: IMPLICIT_CONTEXT_OK',
    );

    assertCanonicalResponse(response, 'openai');
    expect(response.text).toContain('IMPLICIT_CONTEXT_OK');
    expect(contexts[0]).toEqual(
      expect.objectContaining({
        contextWindow: client.models.get(providerModels.openai).contextWindow,
        model: providerModels.openai,
        provider: 'openai',
        reservedOutputTokens: 32,
        toolRound: 0,
      }),
    );
  }, 120_000);

  it('validates strict and permissive tool argument modes', async () => {
    const badToolResponse = buildToolCallResponse({ city: 123 });

    const strict = new Conversation(
      LLMClient.mock({
        responses: [
          badToolResponse,
          buildTextResponse('strict finished', {
            inputTokens: 1,
            outputTokens: 1,
          }),
        ],
      }),
      {
        model: 'mock-model',
        provider: 'mock',
        toolChoice: { name: 'get_weather', type: 'tool' },
        toolValidation: 'strict',
        tools: [weatherTool()],
      },
    );
    await strict.send('weather');
    const strictResult = strict.history.find(messageHasToolResult);
    expect(JSON.stringify(strictResult)).toContain('must be a string');

    let executed = false;
    const permissive = new Conversation(
      LLMClient.mock({
        responses: [
          badToolResponse,
          buildTextResponse('permissive finished', {
            inputTokens: 1,
            outputTokens: 1,
          }),
        ],
      }),
      {
        model: 'mock-model',
        provider: 'mock',
        toolChoice: { name: 'get_weather', type: 'tool' },
        toolValidation: 'permissive',
        tools: [
          weatherTool(() => {
            executed = true;
            return { ok: true };
          }),
        ],
      },
    );
    await permissive.send('weather');
    expect(executed).toBe(true);
  });

  it('runs Session API Request/Response flows with tenant isolation', async () => {
    requireLiveEnv('OPENAI_API_KEY');
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const client = LLMClient.fromEnv({
      retryOptions: { maxAttempts: 2 },
      sessionStore: store,
    });
    const tenantA = runId('tenant_a');
    const tenantB = runId('tenant_b');
    const apiA = createSessionApi({
      client,
      conversationDefaults: {
        maxTokens: 24,
        model: providerModels.openai,
        provider: 'openai',
      },
      middleware: [() => ({ tenantId: tenantA })],
      sessionStore: store,
      tools: [weatherTool()],
    });
    const apiB = createSessionApi({
      client,
      middleware: [() => ({ tenantId: tenantB })],
      sessionStore: store,
    });

    const createResponse = await apiA.handle(
      jsonRequest('POST', '/sessions', {
        messages: [{ content: 'Initial live-real message.', role: 'user' }],
        sessionId: runId('api_session'),
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const sessionId = created.session.id as string;

    const blockedTenantOverride = await apiA.handle(
      jsonRequest('GET', `/sessions?tenantId=${encodeURIComponent(tenantB)}`),
    );
    expect(blockedTenantOverride.status).toBe(400);

    const sendResponse = await apiA.handle(
      jsonRequest('POST', `/sessions/${sessionId}/message`, {
        content: 'Reply with exactly: SESSION_API_OK',
      }),
    );
    expect(sendResponse.status).toBe(200);
    const sent = await sendResponse.json();
    expect(sent.response.text).toContain('SESSION_API_OK');
    expect(sent.session.totals.inputTokens).toBeGreaterThan(0);

    const listA = await apiA.handle(jsonRequest('GET', '/sessions'));
    const listABody = await listA.json();
    expect(
      listABody.sessions.items.some(
        (item: { sessionId: string }) => item.sessionId === sessionId,
      ),
    ).toBe(true);

    const getB = await apiB.handle(
      jsonRequest('GET', `/sessions/${sessionId}`),
    );
    expect(getB.status).toBe(404);

    const messages = await apiA.handle(
      jsonRequest('GET', `/sessions/${sessionId}/messages`),
    );
    expect(messages.status).toBe(200);
    expect((await messages.json()).messages.items.length).toBeGreaterThan(0);

    const compact = await apiA.handle(
      jsonRequest('POST', `/sessions/${sessionId}/compact`, { maxMessages: 2 }),
    );
    expect(compact.status).toBe(200);

    const fork = await apiA.handle(
      jsonRequest('POST', `/sessions/${sessionId}/fork`, {
        fromMessageIndex: 0,
        newSessionId: runId('fork'),
      }),
    );
    expect(fork.status).toBe(201);

    const invalidJson = await apiA.handle(
      new Request('https://live-real.test/sessions', {
        body: '{bad',
        method: 'POST',
      }),
    );
    expect(invalidJson.status).toBe(400);

    const missing = await apiA.handle(
      jsonRequest('POST', `/sessions/${sessionId}/message`, {}),
    );
    expect(missing.status).toBeGreaterThanOrEqual(400);

    const deleted = await apiA.handle(
      jsonRequest('DELETE', `/sessions/${sessionId}`),
    );
    expect(deleted.status).toBe(200);
  }, 180_000);

  it('trims context with sliding window and summarizes with a real LLM', async () => {
    requireLiveEnv('OPENAI_API_KEY');
    const messages: CanonicalMessage[] = [
      { content: 'pinned policy', pinned: true, role: 'system' },
      { content: 'old user one', role: 'user' },
      { content: 'old assistant one', role: 'assistant' },
      { content: 'old user two', role: 'user' },
      { content: 'latest user stays', role: 'user' },
    ];

    const sliding = new SlidingWindowStrategy({ maxMessages: 3 });
    const trimmed = sliding.trim(messages, {});
    expect(trimmed).toHaveLength(3);
    expect(trimmed[0]?.pinned).toBe(true);
    expect(trimmed.at(-1)?.content).toBe('latest user stays');

    const client = liveClient();
    const summarising = new SummarisationStrategy({
      keepLastMessages: 1,
      maxMessages: 4,
      summarizer: async (dropped) => {
        const response = await client.complete({
          maxTokens: 32,
          messages: [
            {
              content: `Summarize these dropped messages in fewer than 12 words: ${JSON.stringify(
                dropped,
              )}`,
              role: 'user',
            },
          ],
          model: providerModels.openai,
          provider: 'openai',
          ...liveTemperature('openai', providerModels.openai),
        });
        return response.text;
      },
    });
    const summarized = await summarising.trim(messages, {});
    expect(
      summarized.some((message) => message.metadata?.summary === true),
    ).toBe(true);
    expect(summarized.some((message) => message.pinned)).toBe(true);

    const failing = new SummarisationStrategy({
      keepLastMessages: 0,
      maxMessages: 3,
      summarizer: () => {
        throw new Error('summarizer failed');
      },
    });
    await expect(failing.trim(messages, {})).rejects.toThrow(
      'summarizer failed',
    );
  }, 180_000);

  it('loads older snapshots that are missing reasoning totals safely', () => {
    const snapshot = {
      createdAt: new Date().toISOString(),
      messages: [{ content: 'hello', role: 'user' }],
      sessionId: runId('old_snapshot'),
      totalCachedTokens: 0,
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      updatedAt: new Date().toISOString(),
    } satisfies Omit<ConversationSnapshot, 'totalReasoningTokens'>;

    const restored = Conversation.restore(
      LLMClient.mock(),
      snapshot as ConversationSnapshot,
    );
    expect(restored.totals.reasoningTokens).toBe(0);
    expect(restored.history).toHaveLength(1);
  });
});

function messageHasToolResult(message: CanonicalMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === 'tool_result')
  );
}

function createRedactedGeminiFetchProbe(evidence: {
  firstResponseSigned: boolean;
  providerCalls: number;
  replaySigned: boolean;
}): typeof fetch {
  return async (input, init) => {
    evidence.providerCalls += 1;
    if (typeof init?.body === 'string' && evidence.providerCalls > 1) {
      const request = JSON.parse(init.body) as {
        contents?: Array<{ parts?: Array<Record<string, unknown>> }>;
      };
      evidence.replaySigned =
        request.contents?.some((content) =>
          content.parts?.some(
            (part) =>
              'functionCall' in part &&
              ('thoughtSignature' in part || 'thought_signature' in part),
          ),
        ) ?? false;
    }

    const response = await fetch(input, init);
    if (evidence.providerCalls === 1 && response.ok) {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') ?? '';
      const payloads: unknown[] = [];
      if (contentType.includes('text/event-stream')) {
        const text = await clone.text();
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') {
            payloads.push(JSON.parse(data));
          }
        }
      } else {
        payloads.push(await clone.json());
      }
      evidence.firstResponseSigned = payloads.some((payload) =>
        responseHasSignedToolPart(payload),
      );
    }
    return response;
  };
}

function responseHasSignedToolPart(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    return false;
  }
  return candidates.some((candidate) => {
    const parts = (candidate as { content?: { parts?: unknown } }).content
      ?.parts;
    return (
      Array.isArray(parts) &&
      parts.some(
        (part) =>
          part !== null &&
          typeof part === 'object' &&
          ('functionCall' in part || (part as { thought?: boolean }).thought) &&
          ('thoughtSignature' in part || 'thought_signature' in part),
      )
    );
  });
}

function jsonRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`https://live-real.test${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      'content-type': 'application/json',
    },
    method,
  });
}

function buildToolCallResponse(args: { city: number }): CanonicalResponse {
  return {
    content: [
      {
        args,
        id: 'call_live_real',
        name: 'get_weather',
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
        args,
        id: 'call_live_real',
        name: 'get_weather',
      },
    ],
    usage: {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: 1,
      outputTokens: 1,
    },
  };
}

function buildTextResponse(
  text: string,
  usage: { inputTokens: number; outputTokens: number },
): CanonicalResponse {
  return {
    content: [{ text, type: 'text' }],
    finishReason: 'stop',
    model: 'mock-model',
    provider: 'mock',
    raw: {},
    text,
    toolCalls: [],
    usage: {
      cachedTokens: 0,
      cost: '$0.00',
      costUSD: 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}
