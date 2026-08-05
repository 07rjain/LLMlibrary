import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import { liveRealEnabled } from './helpers.js';

const liveDescribe = liveRealEnabled ? describe : describe.skip;

const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
) as { exports?: Record<string, unknown> };
const subpaths = Object.keys(packageJson.exports ?? {}).map((key) =>
  key === '.' ? 'unified-llm-client' : `unified-llm-client${key.slice(1)}`,
);

if (subpaths.includes('#provider-runtime')) {
  throw new Error('The private provider runtime must not be a package export.');
}

liveDescribe('live-real package exports', () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('imports built package exports from a clean ESM, CJS, and TS consumer', () => {
    expect(existsSync('dist/index.js')).toBe(true);
    expect(existsSync('dist/index.cjs')).toBe(true);
    expect(existsSync('dist/index.d.ts')).toBe(true);

    const temp = mkdtempSync(join(tmpdir(), 'unified-llm-client-real-'));
    tempDirs.push(temp);
    mkdirSync(join(temp, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(temp, 'node_modules', 'unified-llm-client'), 'dir');
    writeFileSync(
      join(temp, 'package.json'),
      JSON.stringify(
        {
          dependencies: {
            '@types/node': '*',
            typescript: '*',
            'unified-llm-client': 'file:../repo',
          },
          devDependencies: {},
          name: 'live-real-consumer',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(temp, 'esm.mjs'),
      `${subpaths
        .map((path, index) => `const mod${index} = await import('${path}');`)
        .join('\n')}
${subpaths.map((_path, index) => `if (!mod${index}) throw new Error('missing ${index}');`).join('\n')}
`,
    );
    execFileSync(process.execPath, [join(temp, 'esm.mjs')], {
      cwd: temp,
      stdio: 'pipe',
    });

    writeFileSync(
      join(temp, 'cjs.cjs'),
      `${subpaths
        .map((path, index) => `const mod${index} = require('${path}');`)
        .join('\n')}
${subpaths.map((_path, index) => `if (!mod${index}) throw new Error('missing ${index}');`).join('\n')}
`,
    );
    execFileSync(process.execPath, [join(temp, 'cjs.cjs')], {
      cwd: temp,
      stdio: 'pipe',
    });

    writeFileSync(
      join(temp, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            strict: true,
            target: 'ES2022',
          },
          include: ['consumer.ts'],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(temp, 'consumer.ts'),
      `import { LLMClient, InMemorySessionStore, type ConversationSnapshot } from 'unified-llm-client';
import { AgentFilesError, type AgentInstructions } from 'unified-llm-client/agent-files';
import { LLMClient as ClientEntry } from 'unified-llm-client/client';
import { retrieveAndComplete, type RetrieveAndCompleteResult } from 'unified-llm-client/chatbot';
import { chunkText, type TextChunk } from 'unified-llm-client/chunking';
import { LLMError } from 'unified-llm-client/errors';
import { ModelRegistry, type ModelRegistryOptions } from 'unified-llm-client/models';
import { redactPII, type PIIRedactionResult } from 'unified-llm-client/pii';
import { AnthropicAdapter } from 'unified-llm-client/providers/anthropic';
import { GeminiAdapter } from 'unified-llm-client/providers/gemini';
import { OpenAIAdapter } from 'unified-llm-client/providers/openai';
import { createDenseRetriever, type RetrievalResult } from 'unified-llm-client/retrieval';
import { createSessionApi } from 'unified-llm-client/session-api';
import { RedisSessionStore, type SessionMeta } from 'unified-llm-client/session-store';
import { formatCost } from 'unified-llm-client/utils';

const client = LLMClient.mock();
const store = new InMemorySessionStore<ConversationSnapshot>();
createSessionApi({ client, sessionStore: store });
const registryOptions: ModelRegistryOptions = {};
new ModelRegistry(undefined, registryOptions);
const agentError = new AgentFilesError('consumer');
const agentInstructions: AgentInstructions | undefined = undefined;
const clientEntry: ClientEntry = client;
const chunks: TextChunk[] = chunkText('consumer');
const grounded: RetrieveAndCompleteResult | undefined = undefined;
const modelError = new LLMError('consumer');
const pii: PIIRedactionResult = redactPII('consumer@example.com');
const retrieval: RetrievalResult | undefined = undefined;
const sessionMeta: SessionMeta | undefined = undefined;
void [agentError, agentInstructions, clientEntry, chunks, grounded, modelError, pii, retrieval, sessionMeta];
void AnthropicAdapter;
void GeminiAdapter;
void OpenAIAdapter;
void RedisSessionStore;
void createDenseRetriever;
void retrieveAndComplete;
const cost: string = formatCost(0);
if (!cost) throw new Error('missing cost');
`,
    );
    execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', temp], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
  }, 60_000);
});
