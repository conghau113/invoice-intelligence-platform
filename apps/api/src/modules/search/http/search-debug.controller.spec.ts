import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import type { RetrievalService } from '../application/retrieval';
import { SearchDebugController } from './search-debug.controller';

const TENANT = '00000000-0000-4000-8000-0000000000a1';

function controller(nodeEnv: Env['NODE_ENV']) {
  const calls: unknown[][] = [];
  const retrieval = {
    retrieve: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ model: 'm', topK: 5, candidates: 20, chunks: [] });
    },
  } as unknown as RetrievalService;
  const config = { get: () => nodeEnv } as unknown as ConfigService<Env, true>;
  return { ctl: new SearchDebugController(retrieval, config), calls };
}

const req = { user: { tenantId: TENANT } } as unknown as AuthenticatedRequest;

describe('SearchDebugController', () => {
  it('is 404 in production, before anything is read or embedded', () => {
    const { ctl, calls } = controller('production');
    expect(() => ctl.debug({ question: 'SAMPLE' }, req)).toThrow(NotFoundException);
    expect(calls).toEqual([]);
  });

  it('elsewhere asks retrieval for the caller tenant, with the trimmed question and top-k', async () => {
    const { ctl, calls } = controller('development');
    await ctl.debug({ question: '  cà phê SAMPLE  ', topK: 3 }, req);
    expect(calls).toEqual([[TENANT, 'cà phê SAMPLE', { topK: 3 }]]);
  });
});
