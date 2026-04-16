import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const dependencies = Object.keys(packageJson.dependencies ?? {}).sort();
const threshold = 10;

console.log(
  JSON.stringify(
    {
      dependencyCount: dependencies.length,
      dependencies,
      ok: dependencies.length < threshold,
      threshold,
    },
    null,
    2,
  ),
);

if (dependencies.length >= threshold) {
  throw new Error(
    `Runtime dependency count ${dependencies.length} exceeds the threshold of ${threshold - 1}.`,
  );
}
