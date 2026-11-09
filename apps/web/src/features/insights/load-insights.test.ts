import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleInsights } from './insights-fixtures';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ result: {} as unknown, path: '' }));
vi.mock('@/lib/api', () => ({
  apiGet: (path: string) => {
    api.path = path;
    return Promise.resolve(api.result);
  },
}));

import { loadInsights } from './load-insights';

beforeEach(() => {
  api.path = '';
});

describe('loadInsights', () => {
  it('asks the API for the extraction insights and returns a body that matches the contract', async () => {
    api.result = { kind: 'ok', data: sampleInsights() };
    expect(await loadInsights()).toEqual({ kind: 'ok', data: sampleInsights() });
    expect(api.path).toBe('/insights/extraction');
  });

  it.each([
    [{ kind: 'unauthorized' }, 'session'],
    [{ kind: 'forbidden', code: 'TENANT_FORBIDDEN' }, 'forbidden'],
    [{ kind: 'unavailable' }, 'unreachable'],
  ])('%o -> %s', async (result, error) => {
    api.result = result;
    expect(await loadInsights()).toEqual({ kind: 'error', error });
  });

  it('a body of another shape is an error, never rendered', async () => {
    const data = sampleInsights();
    (data.online.fields[0] as { rate: number }).rate = 3;
    api.result = { kind: 'ok', data };
    expect(await loadInsights()).toEqual({ kind: 'error', error: 'error' });
  });
});
