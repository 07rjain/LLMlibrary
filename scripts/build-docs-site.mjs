import { spawn } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}.`));
    });
  });
}

await run('pnpm', ['docs:api']);
await rm('docs/api/media', { force: true, recursive: true });
await run('pnpm', ['exec', 'vitepress', 'build', 'docs']);

await rm('docs/.vitepress/dist/api', { force: true, recursive: true });
await cp('docs/api', 'docs/.vitepress/dist/api', { recursive: true });
