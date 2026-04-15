import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        coverage: {
            exclude: [
                'dist-types/**',
                'eslint.config.mjs',
                'prettier.config.mjs',
                'src/index.ts',
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
                branches: 85,
                statements: 90,
            },
        },
        environment: 'node',
        globals: true,
        include: ['test/**/*.test.ts'],
        setupFiles: ['test/setup.ts'],
    },
});
