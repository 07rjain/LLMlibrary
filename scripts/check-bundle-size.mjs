import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const budgets = {
  'dist/index.js': {
    gzip: 70_000,
    raw: 380_000,
  },
  'dist/chunking.js': {
    gzip: 2_000,
    raw: 5_500,
  },
  'dist/providers-anthropic.js': {
    gzip: 10_200,
    raw: 49_000,
  },
  'dist/providers-gemini.js': {
    gzip: 12_400,
    raw: 62_000,
  },
  'dist/providers-openai.js': {
    gzip: 15_700,
    raw: 76_000,
  },
  'dist/retrieval.js': {
    gzip: 14_700,
    raw: 76_200,
  },
};

const results = Object.entries(budgets).map(([file, budget]) => {
  const buffer = readFileSync(new URL(`../${file}`, import.meta.url));
  return {
    file,
    gzipBytes: gzipSync(buffer).length,
    rawBytes: buffer.length,
    ...budget,
  };
});

const failures = results.filter(
  (result) => result.rawBytes > result.raw || result.gzipBytes > result.gzip,
);

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      results,
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  throw new Error(
    `Bundle size budget exceeded for ${failures.map((failure) => failure.file).join(', ')}.`,
  );
}
