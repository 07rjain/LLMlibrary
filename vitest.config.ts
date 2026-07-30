import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '#provider-runtime': new URL(
        './src/internal/provider-runtime.ts',
        import.meta.url,
      ).pathname,
      'unified-llm-client/errors': new URL('./src/errors.ts', import.meta.url).pathname,
      'unified-llm-client/models': new URL('./src/models/index.ts', import.meta.url)
        .pathname,
      'unified-llm-client/session-api': new URL(
        './src/session-api.ts',
        import.meta.url,
      ).pathname,
      'unified-llm-client/utils': new URL(
        './src/utils/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    coverage: {
      exclude: [
        'dist-types/**',
        'eslint.config.mjs',
        'prettier.config.mjs',
        'src/index.ts',
        'src/**/*.d.ts',
        'src/types.ts',
        'src/models/index.ts',
        'src/utils/index.ts',
        'test/setup.ts',
        'tsup.config.ts',
        'vitest.config.ts',
      ],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 83.9,
        statements: 90,
      },
    },
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts', 'Test_Droid/**/*.test.ts'],
    setupFiles: ['test/setup.ts', 'Test_Droid/setup.ts'],
  },
});
