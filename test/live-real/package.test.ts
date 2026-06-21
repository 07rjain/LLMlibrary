import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const subpaths = [
  'unified-llm-client',
  'unified-llm-client/agent-files',
  'unified-llm-client/client',
  'unified-llm-client/chunking',
  'unified-llm-client/errors',
  'unified-llm-client/models',
  'unified-llm-client/providers/openai',
  'unified-llm-client/providers/anthropic',
  'unified-llm-client/providers/gemini',
  'unified-llm-client/retrieval',
  'unified-llm-client/session-api',
  'unified-llm-client/utils',
] as const;

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
import { createSessionApi } from 'unified-llm-client/session-api';
import { ModelRegistry } from 'unified-llm-client/models';
import { OpenAIAdapter } from 'unified-llm-client/providers/openai';
import { AnthropicAdapter } from 'unified-llm-client/providers/anthropic';
import { GeminiAdapter } from 'unified-llm-client/providers/gemini';
import { LLMError } from 'unified-llm-client/errors';
import { formatCost } from 'unified-llm-client/utils';

const client = LLMClient.mock();
const store = new InMemorySessionStore<ConversationSnapshot>();
createSessionApi({ client, sessionStore: store });
new ModelRegistry();
LLMError;
OpenAIAdapter;
AnthropicAdapter;
GeminiAdapter;
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
