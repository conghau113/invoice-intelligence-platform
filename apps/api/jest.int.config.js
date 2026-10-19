/**
 * Integration tests start their own Postgres (Testcontainers, needs Docker) and apply the real
 * migrations; no dev database or env file is involved. Run: `pnpm --filter api test:int`.
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: 'test',
  testRegex: '.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/support/postgres.global-setup.ts',
  globalTeardown: '<rootDir>/support/postgres.global-teardown.ts',
  testTimeout: 30000,
};
