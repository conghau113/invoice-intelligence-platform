/**
 * RAG evaluation harness (T5.6): calls real models through the AI service, so it is never part of
 * `test` or `test:int` (different file suffix) nor of CI. Same throw-away Postgres as the
 * integration tests. Run from the repo root: `pnpm eval:rag:run` (see eval/rag/README.md).
 * @type {import('jest').Config}
 */
module.exports = {
  rootDir: 'test',
  testRegex: '.*\\.eval-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/support/postgres.global-setup.ts',
  globalTeardown: '<rootDir>/support/postgres.global-teardown.ts',
  // Three repeats of 30 questions, paced for free-tier limits, plus the first embedding: hours.
  testTimeout: 4 * 60 * 60 * 1000,
};
