import process from 'node:process';
import { spawn } from 'node:child_process';

const child = spawn(
  'pnpm',
  ['exec', 'vitest', 'run', 'test/prompt_caching_test/prompt-caching.live.test.ts'],
  {
    env: {
      ...process.env,
      LIVE_TESTS: process.env.LIVE_TESTS ?? '1',
    },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  globalThis.console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
