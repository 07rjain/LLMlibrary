const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');

try {
  Object.defineProperty(globalThis, 'process', {
    configurable: true,
    enumerable: false,
    value: undefined,
    writable: true,
  });

  const module = await import(new URL('../dist/index.js', import.meta.url).href);
  const {
    InMemorySessionStore,
    LLMClient,
    SlidingWindowStrategy,
    createSessionApi,
  } = module;

  const sessionStore = new InMemorySessionStore();
  const client = LLMClient.mock({
    defaultModel: 'mock-model',
    defaultProvider: 'mock',
    responses: [
      {
        content: [{ text: 'Pong', type: 'text' }],
        finishReason: 'stop',
        model: 'mock-model',
        provider: 'mock',
        raw: {},
        text: 'Pong',
        toolCalls: [],
        usage: {
          cachedTokens: 0,
          cost: '$0.00',
          costUSD: 0,
          inputTokens: 1,
          outputTokens: 1,
        },
      },
    ],
    sessionStore,
  });
  const conversation = await client.conversation({
    contextManager: new SlidingWindowStrategy({ maxMessages: 4 }),
    sessionId: 'edge-check',
    system: 'Be concise.',
  });
  await conversation.send('Ping');

  const api = createSessionApi({
    client,
    sessionStore,
    tenantResolution: 'single-tenant',
  });
  const response = await api.handle(
    new Request('https://example.test/sessions/edge-check', {
      method: 'GET',
    }),
  );

  console.log(
    JSON.stringify(
      {
        edgeImportOk: true,
        responseStatus: response.status,
        sessionId: conversation.id,
      },
      null,
      2,
    ),
  );

  if (response.status !== 200) {
    throw new Error(`Expected edge compatibility probe to return 200, received ${response.status}.`);
  }
} finally {
  if (processDescriptor) {
    Object.defineProperty(globalThis, 'process', processDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'process');
  }
}
