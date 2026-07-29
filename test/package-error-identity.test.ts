import {
  execFileSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const esmConsumer = String.raw`
import assert from 'node:assert/strict';

const root = await import('unified-llm-client');
const errors = await import('unified-llm-client/errors');
const models = await import('unified-llm-client/models');
const clientModule = await import('unified-llm-client/client');
const sessionApiModule = await import('unified-llm-client/session-api');
const anthropic = await import('unified-llm-client/providers/anthropic');
const gemini = await import('unified-llm-client/providers/gemini');
const openai = await import('unified-llm-client/providers/openai');

assert.equal(errors.ProviderCapabilityError, root.ProviderCapabilityError);

async function capture(operation) {
  try {
    await operation();
    assert.fail('Expected ProviderCapabilityError');
  } catch (error) {
    assert.equal(error.name, 'ProviderCapabilityError');
    assert.equal(error instanceof errors.ProviderCapabilityError, true);
    assert.equal(error instanceof root.ProviderCapabilityError, true);
    return error;
  }
}

const contextError = await capture(() =>
  new root.SlidingWindowStrategy({ maxMessages: Number.NaN }),
);
assert.equal(contextError.statusCode, 400);
assert.equal(contextError.details.option, 'maxMessages');
assert.equal(contextError.details.constraint, 'finite_non_negative_integer');

const anthropicError = await capture(() =>
  anthropic.translateAnthropicRequest({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 10,
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: -1 },
      },
    },
  }),
);
assert.equal(anthropicError.details.constraint, 'non_negative');

const effortRequest = anthropic.translateAnthropicRequest({
  model: 'claude-opus-5',
  messages: [{ role: 'user', content: 'x' }],
  maxTokens: 64,
  providerOptions: {
    anthropic: {
      effort: 'xhigh',
    },
  },
  responseFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
      required: ['answer'],
    },
  },
});
assert.equal('effort' in effortRequest, false);
assert.equal(effortRequest.output_config.effort, 'xhigh');
assert.equal(effortRequest.output_config.format.type, 'json_schema');

const invalidEffortError = await capture(() =>
  anthropic.translateAnthropicRequest({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 64,
    providerOptions: {
      anthropic: {
        effort: 'ultra',
      },
    },
  }),
);
assert.equal(invalidEffortError.details.effort, 'ultra');

const clientEmbeddingError = await capture(() =>
  new clientModule.LLMClient().embed({ input: null }),
);
assert.equal(clientEmbeddingError.statusCode, 400);
assert.equal(clientEmbeddingError.details.option, 'input');

const translatorEmbeddingError = await capture(() =>
  gemini.translateGeminiEmbeddingRequest(
    { model: 'gemini-embedding-2', purpose: 'unknown' },
    'valid',
  ),
);
assert.equal(translatorEmbeddingError.details.option, 'purpose');

let invalidEmbeddingFetches = 0;
const embeddingAdapter = new gemini.GeminiAdapter({
  apiKey: 'test',
  fetchImplementation: async () => {
    invalidEmbeddingFetches += 1;
    throw new Error('unexpected fetch');
  },
});
await capture(() =>
  embeddingAdapter.embed({
    dimensions: 127,
    input: 'valid',
    model: 'gemini-embedding-2',
  }),
);
assert.equal(invalidEmbeddingFetches, 0);

let unsupportedEffortFetches = 0;
const unsupportedEffortAdapter = new anthropic.AnthropicAdapter({
  apiKey: 'test',
  fetchImplementation: async () => {
    unsupportedEffortFetches += 1;
    throw new Error('unexpected fetch');
  },
});
const unsupportedEffortOptions = {
  model: 'claude-haiku-4-5',
  messages: [{ role: 'user', content: 'x' }],
  maxTokens: 64,
  providerOptions: {
    anthropic: {
      effort: 'low',
    },
  },
};
await capture(() => unsupportedEffortAdapter.complete(unsupportedEffortOptions));
await capture(() => unsupportedEffortAdapter.stream(unsupportedEffortOptions).next());
assert.equal(unsupportedEffortFetches, 0);

await capture(() =>
  gemini.translateGeminiRequest({
    model: 'gemini-3.5-flash',
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_call', id: 'call-1', name: 'tool', args: {} }],
      },
    ],
  }),
);

await capture(() =>
  openai.translateOpenAIRequest({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: [{ type: 'audio', data: 'x', mediaType: 'audio/wav' }],
      },
    ],
  }),
);

await capture(() => new models.ModelRegistry().get('missing-model'));
await capture(() =>
  new clientModule.LLMClient().complete({
    model: 'missing-model',
    messages: [{ role: 'user', content: 'x' }],
  }),
);

const snapshot = {
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [],
  sessionId: 'identity-test',
  totalCachedTokens: 0,
  totalCostUSD: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const sessionStore = {
  async get() {
    return {
      meta: {
        createdAt: snapshot.createdAt,
        messageCount: 0,
        sessionId: snapshot.sessionId,
        totalCostUSD: 0,
        updatedAt: snapshot.updatedAt,
      },
      snapshot,
    };
  },
};
const sessionClient = {
  async getUsage() {
    throw new errors.ProviderCapabilityError('unsupported usage lookup');
  },
};
const api = sessionApiModule.createSessionApi({
  client: sessionClient,
  sessionStore,
});
const sessionResponse = await api.handle(
  new Request('https://example.test/sessions/identity-test?include=usage'),
);
assert.equal(sessionResponse.status, 200);
const sessionBody = await sessionResponse.json();
assert.equal(sessionBody.session.usage, null);
`;

const cjsConsumer = String.raw`
const assert = require('node:assert/strict');

(async () => {
  const root = require('unified-llm-client');
  const errors = require('unified-llm-client/errors');
  const models = require('unified-llm-client/models');
  const clientModule = require('unified-llm-client/client');
  const sessionApiModule = require('unified-llm-client/session-api');
  const anthropic = require('unified-llm-client/providers/anthropic');
  const gemini = require('unified-llm-client/providers/gemini');
  const openai = require('unified-llm-client/providers/openai');

  assert.equal(errors.ProviderCapabilityError, root.ProviderCapabilityError);

  async function capture(operation) {
    try {
      await operation();
      assert.fail('Expected ProviderCapabilityError');
    } catch (error) {
      assert.equal(error.name, 'ProviderCapabilityError');
      assert.equal(error instanceof errors.ProviderCapabilityError, true);
      assert.equal(error instanceof root.ProviderCapabilityError, true);
      return error;
    }
  }

  const contextError = await capture(() =>
    new root.SlidingWindowStrategy({ maxMessages: Number.NaN }),
  );
  assert.equal(contextError.statusCode, 400);
  assert.equal(contextError.details.option, 'maxMessages');
  assert.equal(contextError.details.constraint, 'finite_non_negative_integer');

  const anthropicError = await capture(() =>
    anthropic.translateAnthropicRequest({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 10,
      providerOptions: {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: -1 },
        },
      },
    }),
  );
  assert.equal(anthropicError.details.constraint, 'non_negative');

  const clientEmbeddingError = await capture(() =>
    new clientModule.LLMClient().embed({ input: null }),
  );
  assert.equal(clientEmbeddingError.statusCode, 400);
  assert.equal(clientEmbeddingError.details.option, 'input');

  const translatorEmbeddingError = await capture(() =>
    gemini.translateGeminiEmbeddingRequest(
      { model: 'gemini-embedding-2', purpose: 'unknown' },
      'valid',
    ),
  );
  assert.equal(translatorEmbeddingError.details.option, 'purpose');

  let invalidEmbeddingFetches = 0;
  const embeddingAdapter = new gemini.GeminiAdapter({
    apiKey: 'test',
    fetchImplementation: async () => {
      invalidEmbeddingFetches += 1;
      throw new Error('unexpected fetch');
    },
  });
  await capture(() =>
    embeddingAdapter.embed({
      dimensions: 127,
      input: 'valid',
      model: 'gemini-embedding-2',
    }),
  );
  assert.equal(invalidEmbeddingFetches, 0);

  const effortRequest = anthropic.translateAnthropicRequest({
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 64,
    providerOptions: {
      anthropic: {
        effort: 'xhigh',
      },
    },
    responseFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
        required: ['answer'],
      },
    },
  });
  assert.equal('effort' in effortRequest, false);
  assert.equal(effortRequest.output_config.effort, 'xhigh');
  assert.equal(effortRequest.output_config.format.type, 'json_schema');

  const invalidEffortError = await capture(() =>
    anthropic.translateAnthropicRequest({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 64,
      providerOptions: {
        anthropic: {
          effort: 'ultra',
        },
      },
    }),
  );
  assert.equal(invalidEffortError.details.effort, 'ultra');

  let unsupportedEffortFetches = 0;
  const unsupportedEffortAdapter = new anthropic.AnthropicAdapter({
    apiKey: 'test',
    fetchImplementation: async () => {
      unsupportedEffortFetches += 1;
      throw new Error('unexpected fetch');
    },
  });
  const unsupportedEffortOptions = {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'x' }],
    maxTokens: 64,
    providerOptions: {
      anthropic: {
        effort: 'low',
      },
    },
  };
  await capture(() => unsupportedEffortAdapter.complete(unsupportedEffortOptions));
  await capture(() => unsupportedEffortAdapter.stream(unsupportedEffortOptions).next());
  assert.equal(unsupportedEffortFetches, 0);

  await capture(() =>
    gemini.translateGeminiRequest({
      model: 'gemini-3.5-flash',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_call', id: 'call-1', name: 'tool', args: {} }],
        },
      ],
    }),
  );

  await capture(() =>
    openai.translateOpenAIRequest({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [{ type: 'audio', data: 'x', mediaType: 'audio/wav' }],
        },
      ],
    }),
  );

  await capture(() => new models.ModelRegistry().get('missing-model'));
  await capture(() =>
    new clientModule.LLMClient().complete({
      model: 'missing-model',
      messages: [{ role: 'user', content: 'x' }],
    }),
  );

  const snapshot = {
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    sessionId: 'identity-test',
    totalCachedTokens: 0,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const sessionStore = {
    async get() {
      return {
        meta: {
          createdAt: snapshot.createdAt,
          messageCount: 0,
          sessionId: snapshot.sessionId,
          totalCostUSD: 0,
          updatedAt: snapshot.updatedAt,
        },
        snapshot,
      };
    },
  };
  const sessionClient = {
    async getUsage() {
      throw new errors.ProviderCapabilityError('unsupported usage lookup');
    },
  };
  const api = sessionApiModule.createSessionApi({
    client: sessionClient,
    sessionStore,
  });
  const sessionResponse = await api.handle(
    new Request('https://example.test/sessions/identity-test?include=usage'),
  );
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.session.usage, null);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

describe('packed package error identity', () => {
  const temporaryDirectories: string[] = [];

  afterAll(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it(
    'preserves ProviderCapabilityError identity across supported ESM and CJS subpaths',
    () => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'unified-llm-client-package-'));
      temporaryDirectories.push(temporaryDirectory);

      execFileSync('pnpm', ['pack', '--pack-destination', temporaryDirectory, '--silent'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });

      const archive = readdirSync(temporaryDirectory).find((file) => file.endsWith('.tgz'));
      expect(archive).toBeDefined();

      const consumerDirectory = join(temporaryDirectory, 'consumer');
      const packageDirectory = join(consumerDirectory, 'node_modules', 'unified-llm-client');
      mkdirSync(packageDirectory, { recursive: true });
      execFileSync(
        'tar',
        [
          '-xzf',
          join(temporaryDirectory, archive as string),
          '-C',
          packageDirectory,
          '--strip-components=1',
        ],
        { stdio: 'pipe' },
      );
      expect(existsSync(join(packageDirectory, 'package.json'))).toBe(true);

      const esmScript = join(consumerDirectory, 'consumer.mjs');
      writeFileSync(esmScript, esmConsumer);
      execFileSync(process.execPath, [esmScript], {
        cwd: consumerDirectory,
        stdio: 'pipe',
      });

      const cjsScript = join(consumerDirectory, 'consumer.cjs');
      writeFileSync(cjsScript, cjsConsumer);
      execFileSync(process.execPath, [cjsScript], {
        cwd: consumerDirectory,
        stdio: 'pipe',
      });
    },
    120_000,
  );
});
