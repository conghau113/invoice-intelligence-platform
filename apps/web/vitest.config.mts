import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // next-intl (ESM) imports 'next/server' without extension; let Vite resolve it.
    server: { deps: { inline: ['next-intl'] } },
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Up to three suites run at once under turbo, so one worker per core oversubscribes the machine.
    // The timeouts are there to catch a hang: 5 s of wall clock also fails a slow machine, and the
    // first test of a file pays for loading modules (slowest measured under load: 26 s, T3.9).
    maxWorkers: '50%',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
