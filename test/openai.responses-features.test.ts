import { describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../src/client.js';
import { ProviderCapabilityError, ProviderError } from '../src/errors.js';
import { ModelRegistry } from '../src/models/registry.js';
import {
  OpenAIAdapter,
  translateOpenAIRequest,
} from '../src/providers/openai.js';
import { InMemorySessionStore } from '../src/session-store.js';
import { createSessionApi } from '../src/session-api.js';
import type { ConversationSnapshot } from '../src/conversation.js';
import type {
  CanonicalMessage,
  DocumentPart,
  StreamChunk,
} from '../src/types.js';

const pdf: DocumentPart = {
  type: 'document',
  mediaType: 'application/pdf',
  data: 'JVBERi0xLjcK',
  title: 'report.pdf',
};
const messages: CanonicalMessage[] = [{ role: 'user', content: 'Say hello' }];

function response(output?: unknown[], status = 'completed') {
  return {
    id: 'resp_test',
    model: 'gpt-6.1-sol',
    status,
    output: output ?? [
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_1',
        content: [{ type: 'output_text', text: 'Hello' }],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 10 },
    },
  };
}

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function summary(type: string, extra: Record<string, unknown> = {}) {
  return {
    type: `response.reasoning_summary_${type}`,
    item_id: 'rs_1',
    output_index: 0,
    summary_index: 0,
    ...extra,
  };
}

function streamAdapter(events: unknown[]) {
  const fetchImplementation = vi.fn(async () => sse(events));
  return {
    fetchImplementation,
    adapter: new OpenAIAdapter({ apiKey: 'test', fetchImplementation }),
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const chunk of stream) result.push(chunk);
  return result;
}

async function chunks(events: unknown[]): Promise<StreamChunk[]> {
  const { adapter } = streamAdapter(events);
  return collect(adapter.stream({ model: 'gpt-6.1-sol', messages }));
}

describe('OpenAI Responses PDF inputs', () => {
  it.each(['complete', 'stream'] as const)(
    'forwards inline PDFs through %s without changing stateless transport',
    async (operation) => {
      const fetchImplementation = vi.fn(
        async (url: unknown, init?: RequestInit) => {
          expect(String(url)).toBe('https://api.openai.com/v1/responses');
          const body = JSON.parse(init!.body as string);
          expect(body).toMatchObject({
            store: false,
            input: [
              {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_file',
                    filename: 'report.pdf',
                    file_data: 'data:application/pdf;base64,JVBERi0xLjcK',
                  },
                ],
              },
            ],
          });
          expect(body).not.toHaveProperty('previous_response_id');
          return operation === 'stream'
            ? sse([{ type: 'response.completed', response: response() }])
            : Response.json(response());
        },
      );
      const client = new LLMClient({
        openaiApiKey: 'test',
        fetchImplementation,
      });
      const options = {
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user' as const, content: [pdf] }],
      };
      if (operation === 'complete')
        expect((await client.complete(options)).text).toBe('Hello');
      else
        expect((await collect(client.stream(options))).at(-1)?.type).toBe(
          'done',
        );
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    },
  );

  it('forwards HTTPS document URLs for the provider to retrieve', async () => {
    const fetchImplementation = vi.fn(
      async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toBe('https://api.openai.com/v1/responses');
        expect(JSON.parse(init!.body as string).input[0].content).toEqual([
          { type: 'input_file', file_url: 'https://example.com/report.pdf' },
        ]);
        return Response.json(response());
      },
    );
    const client = new LLMClient({ openaiApiKey: 'test', fetchImplementation });
    await client.complete({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              url: 'https://example.com/report.pdf',
            },
          ],
        },
      ],
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('supplies a default inline filename', () => {
    const document = { ...pdf };
    delete document.title;
    expect(
      translateOpenAIRequest({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: [document] }],
      }).input,
    ).toMatchObject([{ content: [{ filename: 'document.pdf' }] }]);
  });

  it.each([
    { ...pdf, mediaType: 'text/plain' },
    { ...pdf, data: '' },
    { ...pdf, data: 'not base64' },
    { ...pdf, data: 'A===' },
    { ...pdf, data: 'AAA' },
    { ...pdf, data: 5 },
    { ...pdf, data: undefined },
    { ...pdf, title: '' },
    { ...pdf, url: 'https://example.com/report.pdf' },
    {
      type: 'document',
      mediaType: 'application/pdf',
      url: 'http://example.com/a.pdf',
    },
    {
      type: 'document',
      mediaType: 'application/pdf',
      url: 'https://user:password@example.com/a.pdf',
    },
    { type: 'document', mediaType: 'application/pdf', url: 'invalid' },
    { type: 'document', mediaType: 'application/pdf', url: 123 },
  ])('rejects invalid PDF inputs before transport %#', async (document) => {
    const fetchImplementation = vi.fn();
    const adapter = new OpenAIAdapter({ apiKey: 'test', fetchImplementation });
    await expect(
      adapter.complete({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: [document as DocumentPart] }],
      }),
    ).rejects.toBeInstanceOf(ProviderCapabilityError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('requires vision support and keeps documents out of assistant/system messages', async () => {
    const modelRegistry = new ModelRegistry(undefined, {
      emitStalenessWarning: false,
    });
    modelRegistry.register({
      ...modelRegistry.get('gpt-6.1-sol'),
      id: 'text-only',
      supportsVision: false,
    });
    const fetchImplementation = vi.fn();
    const adapter = new OpenAIAdapter({
      apiKey: 'test',
      fetchImplementation,
      modelRegistry,
    });
    await expect(
      adapter.complete({
        model: 'text-only',
        messages: [{ role: 'user', content: [pdf] }],
      }),
    ).rejects.toThrow('vision');
    for (const role of ['assistant', 'system'] as const) {
      await expect(
        adapter.complete({
          model: 'gpt-6.1-sol',
          messages: [{ role, content: [pdf] }],
        }),
      ).rejects.toBeInstanceOf(ProviderCapabilityError);
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe('OpenAI verbosity and conversation persistence', () => {
  it.each(['low', 'medium', 'high'] as const)(
    'combines %s verbosity with structured output',
    (verbosity) => {
      const body = translateOpenAIRequest({
        model: 'gpt-6.1-sol',
        messages,
        providerOptions: { openai: { verbosity } },
        responseFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
        },
      });
      expect(body.text).toMatchObject({
        verbosity,
        format: { type: 'json_schema', strict: true },
      });
    },
  );

  it('supports verbosity without structured output and preserves the omitted default', () => {
    expect(
      translateOpenAIRequest({
        model: 'gpt-5.4',
        messages,
        providerOptions: { openai: { verbosity: 'low' } },
      }).text,
    ).toEqual({ verbosity: 'low' });
    expect(
      translateOpenAIRequest({ model: 'gpt-4o', messages }),
    ).not.toHaveProperty('text');
  });

  it.each([
    ['gpt-4o', 'low'],
    ['o3', 'high'],
    ['gpt-6.1-sol', 'extreme'],
    ['gpt-6.1-sol', null],
    ['gpt-6.1-sol', 1],
  ])(
    'rejects incompatible verbosity before dispatch: %s / %s',
    async (model, verbosity) => {
      const fetchImplementation = vi.fn();
      const client = new LLMClient({
        openaiApiKey: 'test',
        fetchImplementation,
      });
      await expect(
        client.complete({
          model: model as string,
          messages,
          providerOptions: { openai: { verbosity } },
        } as never),
      ).rejects.toThrow('verbosity');
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it('restores PDF history and verbosity, while summaries stay out of answer history', async () => {
    const store = new InMemorySessionStore<ConversationSnapshot>();
    const fetchImplementation = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        Response.json(
          response([
            {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: 'I reviewed the document.' },
              ],
              encrypted_content: 'opaque',
            },
            ...response().output,
          ]),
        ),
    );
    const client = new LLMClient({
      openaiApiKey: 'test',
      fetchImplementation,
      sessionStore: store,
    });
    const first = await client.conversation({
      sessionId: 'pdf-session',
      model: 'gpt-6.1-sol',
      providerOptions: {
        openai: { verbosity: 'low', reasoning: { summary: 'auto' } },
      },
    });
    expect((await first.send([pdf])).reasoningSummary).toBe(
      'I reviewed the document.',
    );
    const restored = await client.conversation({ sessionId: 'pdf-session' });
    await restored.send('What else?');
    const body = JSON.parse(
      fetchImplementation.mock.calls[1]![1]!.body as string,
    );
    expect(body.text).toEqual({ verbosity: 'low' });
    expect(body.input[0].content[0].type).toBe('input_file');
    expect(JSON.stringify(body.input)).not.toContain(
      'I reviewed the document.',
    );
    expect(JSON.stringify(body.input)).not.toContain('opaque');
    expect(restored.toMessages().at(-1)?.content).toBe('Hello');
    const snapshot = restored.serialise();
    await store.set('invalid', {
      ...snapshot,
      sessionId: 'invalid',
      providerOptions: { openai: { verbosity: 'invalid' as never } },
    });
    await expect(client.conversation({ sessionId: 'invalid' })).rejects.toThrow(
      'snapshot',
    );
  });
});

describe('OpenAI provider-authored reasoning summaries', () => {
  it.each([false, true])(
    'exposes summaries through the Session API (stream=%s)',
    async (stream) => {
      const store = new InMemorySessionStore<ConversationSnapshot>();
      const completed = response([
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Reviewed' }],
        },
        ...response().output,
      ]);
      const fetchImplementation = vi.fn(async () =>
        stream
          ? sse([
              summary('text.delta', { delta: 'Reviewed' }),
              summary('text.done', { text: 'Reviewed' }),
              { type: 'response.output_text.delta', delta: 'Hello' },
              { type: 'response.completed', response: completed },
            ])
          : Response.json(completed),
      );
      const client = new LLMClient({
        openaiApiKey: 'test',
        fetchImplementation,
        sessionStore: store,
      });
      const api = createSessionApi({
        client,
        sessionStore: store,
        tenantResolution: 'single-tenant',
        conversationDefaults: {
          model: 'gpt-6.1-sol',
          providerOptions: {
            openai: { verbosity: 'low', reasoning: { summary: 'auto' } },
          },
        },
      });
      const post = (url: string, body: unknown) =>
        api.handle(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      const created = await post('https://example.test/sessions', {});
      expect(created.status).toBe(201);
      const id = (await created.json()).session.id;
      const result = await post(
        `https://example.test/sessions/${id}/message?stream=${stream}`,
        { content: [pdf] },
      );
      expect(result.status).toBe(200);
      if (stream) {
        const text = await result.text();
        expect(text).toContain('event: response.reasoning.started');
        expect(text).toContain('event: response.reasoning.delta');
        expect(text).toContain('event: response.reasoning.completed');
        expect(text).toContain('Reviewed');
      } else
        expect((await result.json()).response.reasoningSummary).toBe(
          'Reviewed',
        );
      expect(
        JSON.stringify((await store.get(id))?.snapshot.messages),
      ).not.toContain('Reviewed');
    },
  );

  it('normalizes multiple summary parts separately from the answer and encrypted reasoning', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test',
      fetchImplementation: vi.fn(async () =>
        Response.json(
          response([
            {
              type: 'reasoning',
              summary: [
                { type: 'summary_text', text: 'First' },
                { type: 'summary_text', text: '' },
              ],
              encrypted_content: 'secret',
            },
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Second' }],
            },
            ...response().output,
          ]),
        ),
      ),
    });
    const result = await adapter.complete({ model: 'gpt-6.1-sol', messages });
    expect(result.reasoningSummary).toBe('First\n\nSecond');
    expect(result.text).toBe('Hello');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.usage.reasoningTokens).toBe(10);
  });

  it('omits empty or absent summaries', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test',
      fetchImplementation: vi.fn(async () =>
        Response.json(
          response([
            { type: 'reasoning', encrypted_content: 'secret' },
            { type: 'reasoning', summary: [] },
            ...response().output,
          ]),
        ),
      ),
    });
    expect(
      await adapter.complete({ model: 'gpt-6.1-sol', messages }),
    ).not.toHaveProperty('reasoningSummary');
  });

  it.each([
    null,
    'secret',
    [null],
    [{ type: 'raw_text', text: 'secret' }],
    [{ type: 'summary_text', text: 1 }],
  ])('rejects malformed summary output %#', async (value) => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test',
      fetchImplementation: vi.fn(async () =>
        Response.json(
          response([
            { type: 'reasoning', summary: value },
            ...response().output,
          ]),
        ),
      ),
    });
    await expect(
      adapter.complete({ model: 'gpt-6.1-sol', messages }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('streams summaries exactly once and ignores raw/encrypted reasoning events', async () => {
    const result = await chunks([
      summary('part.added', { part: { type: 'summary_text', text: '' } }),
      summary('text.delta', { delta: 'Checking ' }),
      summary('text.delta', { delta: 'facts.' }),
      summary('text.done', { text: 'Checking facts.' }),
      summary('part.done', {
        part: { type: 'summary_text', text: 'Checking facts.' },
      }),
      { type: 'response.reasoning_text.delta', delta: 'private' },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.completed', response: response() },
    ]);
    expect(result.slice(0, 5)).toEqual([
      { type: 'reasoning-start' },
      { type: 'reasoning-delta', delta: 'Checking ' },
      { type: 'reasoning-delta', delta: 'facts.' },
      { type: 'reasoning-end' },
      { type: 'text-delta', delta: 'Hello' },
    ]);
    expect(result.at(-1)).toMatchObject({
      type: 'done',
      usage: { reasoningTokens: 10 },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each(['text.done', 'part.done'])(
    'recovers summary text when only %s is emitted',
    async (type) => {
      const result = await chunks([
        summary(
          type,
          type === 'text.done'
            ? { text: 'Summary' }
            : { part: { type: 'summary_text', text: 'Summary' } },
        ),
        { type: 'response.completed', response: response() },
      ]);
      expect(result.slice(0, 3)).toEqual([
        { type: 'reasoning-start' },
        { type: 'reasoning-delta', delta: 'Summary' },
        { type: 'reasoning-end' },
      ]);
    },
  );

  it('handles initial text, distinct parts, and terminal closure without merging answer text', async () => {
    const result = await chunks([
      summary('part.added', { part: { type: 'summary_text', text: 'First' } }),
      summary('text.delta', { summary_index: 1, delta: 'Second' }),
      summary('part.done', { part: { type: 'summary_text', text: 'First' } }),
      { type: 'response.completed', response: response() },
    ]);
    expect(
      result.filter((chunk) => chunk.type.startsWith('reasoning')),
    ).toEqual([
      { type: 'reasoning-start' },
      { type: 'reasoning-delta', delta: 'First' },
      { type: 'reasoning-end' },
      { type: 'reasoning-start' },
      { type: 'reasoning-delta', delta: 'Second' },
      { type: 'reasoning-end' },
    ]);
  });

  it('closes summaries before tool events and before incomplete terminal responses', async () => {
    const result = await chunks([
      summary('text.delta', { delta: 'Planning' }),
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '',
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{}',
        },
      },
      summary('text.delta', { item_id: 'rs_2', delta: 'Finishing' }),
      {
        type: 'response.incomplete',
        response: {
          ...response(undefined, 'incomplete'),
          incomplete_details: { reason: 'max_output_tokens' },
        },
      },
    ]);
    expect(
      result.findIndex((chunk) => chunk.type === 'reasoning-end'),
    ).toBeLessThan(
      result.findIndex((chunk) => chunk.type === 'tool-call-start'),
    );
    expect(result.at(-2)).toEqual({ type: 'reasoning-end' });
    expect(result.at(-1)).toMatchObject({
      type: 'done',
      finishReason: 'length',
    });
  });

  it.each([
    summary('text.delta', { delta: 1 }),
    summary('text.delta', { item_id: null, delta: 'secret' }),
    summary('text.delta', { output_index: -1, delta: 'secret' }),
    summary('text.delta', { summary_index: 0.5, delta: 'secret' }),
    summary('part.added', { part: null }),
    summary('part.added', { part: { type: 'raw_text', text: 'secret' } }),
  ])('rejects malformed stream summary events %#', async (event) => {
    await expect(
      chunks([event, { type: 'response.completed', response: response() }]),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it.each([
    [
      summary('text.delta', { delta: 'First' }),
      summary('text.done', { text: 'Different' }),
    ],
    [
      summary('text.done', { text: 'First' }),
      summary('text.delta', { delta: 'late' }),
    ],
  ])('rejects inconsistent or late summary content %#', async (...events) => {
    await expect(
      chunks([...events, { type: 'response.completed', response: response() }]),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('propagates summary events through conversations without persisting them as answers', async () => {
    const fetchImplementation = vi.fn(async () =>
      sse([
        summary('text.delta', { delta: 'A summary' }),
        summary('text.done', { text: 'A summary' }),
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.completed', response: response() },
      ]),
    );
    const client = new LLMClient({ openaiApiKey: 'test', fetchImplementation });
    const conversation = await client.conversation({
      model: 'gpt-6.1-sol',
      providerOptions: { openai: { reasoning: { summary: 'auto' } } },
    });
    const result = await collect(conversation.sendStream('Hello'));
    expect(result.some((chunk) => chunk.type === 'reasoning-delta')).toBe(true);
    expect(conversation.toMessages().at(-1)?.content).toBe('Hello');
    expect(JSON.stringify(conversation.serialise())).not.toContain('A summary');
  });

  it('honors cancellation during summary streaming', async () => {
    const { adapter } = streamAdapter([
      summary('text.delta', { delta: 'Summary' }),
      { type: 'response.completed', response: response() },
    ]);
    const controller = new AbortController();
    const stream = adapter.stream({
      model: 'gpt-6.1-sol',
      messages,
      signal: controller.signal,
    });
    expect((await stream.next()).value).toEqual({ type: 'reasoning-start' });
    controller.abort(new Error('stop'));
    await expect(collect(stream)).rejects.toThrow('stop');
  });
});
