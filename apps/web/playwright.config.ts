import { defineConfig, devices } from '@playwright/test';

const WEB = 'http://localhost:3000';
const API = 'http://localhost:3001';

/**
 * Real browser, real Keycloak, real API, real Postgres. Locally the servers you already run
 * (pnpm dev:api, pnpm --filter web dev, pnpm infra:up) are reused. In CI, E2E_START_SERVERS=1
 * makes Playwright start the production builds itself, with the variables the workflow exports.
 */
const startServers = process.env.E2E_START_SERVERS === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // One worker: every test signs in against the same Keycloak and tenants, and the order of
  // sign-ins should not decide the result.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  globalSetup: './e2e/support/global-setup.ts',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: startServers
    ? [
        {
          command: 'node ../api/dist/main.js',
          url: `${API}/health/ready`,
          reuseExistingServer: false,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000,
        },
        {
          command: 'node node_modules/next/dist/bin/next start',
          url: `${WEB}/api/health`,
          reuseExistingServer: false,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000,
        },
      ]
    : undefined,
});
