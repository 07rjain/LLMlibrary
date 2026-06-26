import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const commands = [
  ['pnpm', ['install']],
  ['pnpm', ['typecheck']],
  ['pnpm', ['lint']],
  ['pnpm', ['test']],
  ['pnpm', ['build']],
  ['pnpm', ['sizecheck']],
  ['pnpm', ['depcheck']],
  ['pnpm', ['edgecheck']],
  ['pnpm', ['pricecheck']],
  ['pnpm', ['run', 'ci']],
];

const startedAt = new Date().toISOString();
const results = [];

for (const [command, args] of commands) {
  const started = Date.now();
  const child = spawnSync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LIVE_TESTS: process.env.LIVE_TESTS ?? '0',
      LIVE_REAL_TESTS: process.env.LIVE_REAL_TESTS ?? '0',
    },
    encoding: 'utf8',
    shell: false,
  });
  const durationMs = Date.now() - started;
  const result = {
    command: [command, ...args].join(' '),
    durationMs,
    exitCode: child.status,
    stderrTail: redact(tail(child.stderr ?? '')),
    stdoutTail: redact(tail(child.stdout ?? '')),
  };
  results.push(result);
  const status = child.status === 0 ? 'PASS' : 'FAIL';
  console.log(`${status} ${result.command} (${durationMs}ms)`);
  if (child.status !== 0) {
    break;
  }
}

const reportPath = resolve(
  process.cwd(),
  'test/live-real/artifacts/package-health-results.json',
);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      finishedAt: new Date().toISOString(),
      results,
      startedAt,
    },
    null,
    2,
  ),
);

if (results.some((result) => result.exitCode !== 0)) {
  process.exit(1);
}

function tail(value) {
  const lines = value.split(/\r?\n/).filter(Boolean);
  return lines.slice(-40).join('\n');
}

function redact(value) {
  let redacted = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (
      !secret ||
      secret.length < 8 ||
      !/(KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|REDIS_URL)/i.test(key)
    ) {
      continue;
    }
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}
