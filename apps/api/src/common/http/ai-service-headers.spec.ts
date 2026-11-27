import { runWithLogContext } from 'logger';
import { aiServiceHeaders } from './ai-service-headers';

const TENANT = '00000000-0000-4000-8000-0000000000a1';

describe('aiServiceHeaders', () => {
  it('sends the token and, inside a tenant context, the tenant id', () => {
    const headers = runWithLogContext({ tenantId: TENANT }, () =>
      aiServiceHeaders('t0ken', { 'content-type': 'application/json' }),
    );
    expect(headers).toEqual({
      authorization: 'Bearer t0ken',
      'content-type': 'application/json',
      'x-tenant-id': TENANT,
    });
  });

  it('sends no tenant outside a context or when the id is not a uuid', () => {
    expect(aiServiceHeaders('t0ken')).toEqual({ authorization: 'Bearer t0ken' });
    expect(runWithLogContext({ tenantId: 'acme' }, () => aiServiceHeaders('t0ken'))).toEqual({
      authorization: 'Bearer t0ken',
    });
  });
});
