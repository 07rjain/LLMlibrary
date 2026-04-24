import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const budgets = {
  'dist/index.js': {
    gzip: 48_500,
    raw: 256_000,
  },
  'dist/providers-anthropic.js': {
    gzip: 8_000,
    raw: 33_500,
  },
  'dist/providers-gemini.js': {
    gzip: 10_000,
    raw: 46_000,
  },
  'dist/providers-openai.js': {
    gzip: 8_500,
    raw: 36_500,
  },
  'dist/retrieval.js': {
    gzip: 11_000,
    raw: 54_000,
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
