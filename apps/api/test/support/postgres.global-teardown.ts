import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export default async function teardown(): Promise<void> {
  const holder = globalThis as { __pgContainer?: StartedPostgreSqlContainer };
  await holder.__pgContainer?.stop();
}
