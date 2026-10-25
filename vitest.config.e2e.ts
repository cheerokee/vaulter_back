import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Os e2e rodam num banco próprio (nunca no de desenvolvimento), criado e migrado pelo globalSetup.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
process.env.DB_DATABASE =
  process.env.DB_TEST_DATABASE ?? `${process.env.DB_DATABASE}_test`;
// Saída limpa nos e2e (e no CI), a menos que alguém peça logs.
process.env.LOG_LEVEL = process.env.E2E_LOG_LEVEL ?? 'silent';
process.env.API_DOCS_INTERNAL_ENABLED ??= 'true';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: './test/setup/global-setup.ts',
    fileParallelism: false,
  },
});
