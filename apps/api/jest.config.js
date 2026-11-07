/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  testEnvironment: 'node',
  // Up to three suites run at once under turbo, so "all cores but one" per suite oversubscribes the
  // machine. The timeout is there to catch a hang: 5 s of wall clock also fails a slow machine, and
  // the first test of a file pays for loading modules (slowest measured under load: 26 s, T3.9).
  maxWorkers: '50%',
  testTimeout: 60_000,
};
