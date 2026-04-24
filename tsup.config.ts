import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    client: 'src/client.ts',
    chunking: 'src/chunking.ts',
    index: 'src/index.ts',
    errors: 'src/errors.ts',
    models: 'src/models/index.ts',
    'providers-anthropic': 'src/providers/anthropic.ts',
    'providers-gemini': 'src/providers/gemini.ts',
    'providers-openai': 'src/providers/openai.ts',
    retrieval: 'src/retrieval.ts',
    'session-api': 'src/session-api.ts',
    utils: 'src/utils/index.ts',
  },
  format: ['esm', 'cjs'],
  minify: false,
  platform: 'neutral',
  sourcemap: true,
  splitting: false,
  target: 'node18',
  treeshake: true,
});
