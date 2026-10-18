import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // next-intl (ESM) imports 'next/server' without extension; let Vite resolve it.
    server: { deps: { inline: ['next-intl'] } },
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
