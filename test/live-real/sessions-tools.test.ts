import { describe, expect, it } from 'vitest';

import { LLMClient } from '../../src/client.js';
import { Conversation, type ConversationSnapshot } from '../../src/conversation.js';
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
  liveRealEnabled,
  providerModels,
  requireLiveEnv,
  runId,
  weatherTool,
} from './helpers.js';

const liveDescribe = liveRealEnabled ? describe : describe.skip;

liveDescribe('live-real sessions, tools, and context', () => {
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
  }, 90_000);

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
  }, 60_000);

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
    expect(listABody.sessions.items.some((item: { sessionId: string }) => item.sessionId === sessionId)).toBe(
      true,
    );

    const getB = await apiB.handle(jsonRequest('GET', `/sessions/${sessionId}`));
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
  }, 120_000);

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
          temperature: 0,
        });
        return response.text;
      },
    });
    const summarized = await summarising.trim(messages, {});
    expect(summarized.some((message) => message.metadata?.summary === true)).toBe(
      true,
    );
    expect(summarized.some((message) => message.pinned)).toBe(true);

    const failing = new SummarisationStrategy({
      keepLastMessages: 0,
      maxMessages: 3,
      summarizer: () => {
        throw new Error('summarizer failed');
      },
    });
    await expect(failing.trim(messages, {})).rejects.toThrow('summarizer failed');
  }, 90_000);

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
