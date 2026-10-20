import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

// apps/api/.test-data is git-ignored. Not os.tmpdir(): a fixed, repo-local place is easy to inspect.
const BASE = path.resolve(__dirname, '../../../../.test-data');

/**
 * Call inside a describe block. `newRoot()` returns a fresh empty directory; every directory made
 * is removed after the suite.
 */
export function useTestRoots(): () => Promise<string> {
  const made: string[] = [];
  afterAll(async () => {
    await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    await mkdir(BASE, { recursive: true });
    const dir = await mkdtemp(path.join(BASE, 'run-'));
    made.push(dir);
    return dir;
  };
}
