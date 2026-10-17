import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { AuthenticatedRequest } from '../modules/auth/http/authenticated-request';
import { Public } from '../modules/auth/http/public.decorator';
import { TenantDbService } from './tenant-db.service';
import { TenantTransactionInterceptor } from './tenant-transaction.interceptor';

const ACME = '00000000-0000-4000-8000-0000000000a1';

const events: string[] = [];
const fakeTenantDb = {
  run: async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    events.push(`begin:${tenantId}`);
    try {
      const out = await fn({});
      events.push('commit');
      return out;
    } catch (e) {
      events.push('rollback');
      throw e;
    }
  },
};

@Controller('probe')
class ProbeController {
  @Get('data')
  data(): { ok: true } {
    events.push('handler');
    return { ok: true };
  }

  @Get('fail')
  fail(): never {
    throw new Error('handler failed');
  }

  @Public()
  @Get('open')
  open(): { ok: true } {
    events.push('handler');
    return { ok: true };
  }
}

describe('TenantTransactionInterceptor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: TenantDbService, useValue: fakeTenantDb },
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
      ],
    }).compile();
    app = mod.createNestApplication();
    // Stands in for JwtAuthGuard: authenticated requests carry req.user, @Public ones do not.
    app.use((req: AuthenticatedRequest, _res: unknown, next: () => void) => {
      if (!req.path.endsWith('/open')) {
        req.user = { userId: 'u', tenantAlias: 'acme', tenantId: ACME, roles: [] };
      }
      next();
    });
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    events.length = 0;
  });

  it('runs the handler inside a transaction for the tenant of the token', async () => {
    await request(app.getHttpServer()).get('/probe/data').expect(200, { ok: true });
    expect(events).toEqual([`begin:${ACME}`, 'handler', 'commit']);
  });

  it('does not open a transaction for a route without a user (@Public)', async () => {
    await request(app.getHttpServer()).get('/probe/open').expect(200);
    expect(events).toEqual(['handler']);
  });

  it('rolls back when the handler throws', async () => {
    await request(app.getHttpServer()).get('/probe/fail').expect(500);
    expect(events).toEqual([`begin:${ACME}`, 'rollback']);
  });
});
