import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './vitepress.wrangler.json' } })],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/fixtures.ts'],
    fileParallelism: false,
  },
});
