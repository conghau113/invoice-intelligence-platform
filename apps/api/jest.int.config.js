/**
 * Integration tests need a real Postgres (`pnpm infra:up`, then db:migrate and db:seed).
 * Not part of `pnpm test` / CI yet; T1.8 moves them to Testcontainers and CI.
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: 'test',
  testRegex: '.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: 'node',
};
