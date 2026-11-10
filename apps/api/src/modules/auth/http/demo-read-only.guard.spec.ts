import type { INestApplication } from '@nestjs/common';
import { Controller, Delete, Get, Patch, Post, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProblemDetailsFilter } from '../../../common/http/problem-details.filter';
import { TENANT_DIRECTORY } from '../application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../application/token-verifier.port';
import { AuthController } from './auth.controller';
import { DemoReadOnlyGuard } from './demo-read-only.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { Public } from './public.decorator';
import { RequirePermission } from './require-permission.decorator';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACME_ID = '00000000-0000-4000-8000-0000000000a1';

@Controller('probe')
class ProbeController {
  @RequirePermission('document:read')
  @Get('read')
  read(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('document:approve')
  @Post('write')
  post(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('document:approve')
  @Put('write')
  put(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('document:approve')
  @Patch('write')
  patch(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('document:manage')
  @Delete('write')
  remove(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Post('public-write')
  publicWrite(): { ok: true } {
    return { ok: true };
  }
}

/** The real guard chain in the production order (AuthModule), with a fake token verifier. */
async function boot(demoReadOnly: boolean): Promise<INestApplication> {
  const verifier = {
    verify: (token: string) =>
      Promise.resolve({
        sub: USER_ID,
        organization: ['acme'],
        realm_access: { roles: token.split(',') },
      }),
  };
  const mod = await Test.createTestingModule({
    controllers: [AuthController, ProbeController],
    providers: [
      { provide: TOKEN_VERIFIER, useValue: verifier },
      {
        provide: TENANT_DIRECTORY,
        useValue: {
          idForAlias: (a: string) => Promise.resolve(a === 'acme' ? ACME_ID : undefined),
        },
      },
      {
        provide: ConfigService,
        useValue: { get: (key: string) => (key === 'DEMO_READ_ONLY' ? demoReadOnly : undefined) },
      },
      { provide: APP_GUARD, useClass: DemoReadOnlyGuard },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ],
  }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

describe('DemoReadOnlyGuard (DEMO_READ_ONLY=true)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await boot(true);
  });
  afterAll(() => app.close());

  it.each(['post', 'put', 'patch', 'delete'] as const)(
    '%s by a tenant_admin -> 403 problem+json with code DEMO_READ_ONLY',
    async (method) => {
      const res = await request(app.getHttpServer())
        [method]('/probe/write')
        .set('Authorization', 'Bearer tenant_admin')
        .expect(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({ status: 403, code: 'DEMO_READ_ONLY' });
    },
  );

  it('refuses a write before authentication: no token -> 403 DEMO_READ_ONLY, not 401', async () => {
    const res = await request(app.getHttpServer()).post('/probe/write').expect(403);
    expect(res.body.code).toBe('DEMO_READ_ONLY');
  });

  it('refuses a write to a @Public route too', async () => {
    const res = await request(app.getHttpServer()).post('/probe/public-write').expect(403);
    expect(res.body.code).toBe('DEMO_READ_ONLY');
  });

  it('lets reads through, still behind authentication', async () => {
    await request(app.getHttpServer())
      .get('/probe/read')
      .set('Authorization', 'Bearer viewer')
      .expect(200);
    await request(app.getHttpServer()).get('/probe/read').expect(401);
  });

  it('/auth/me advertises read permissions only, whatever the roles', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer tenant_admin')
      .expect(200);
    expect(res.body.roles).toEqual(['tenant_admin']);
    expect(res.body.permissions).toEqual(['document:read', 'insights:read']);
  });
});

describe('DemoReadOnlyGuard (DEMO_READ_ONLY=false)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await boot(false);
  });
  afterAll(() => app.close());

  it('does nothing: writes reach the permission check as before', async () => {
    await request(app.getHttpServer())
      .post('/probe/write')
      .set('Authorization', 'Bearer accountant')
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/probe/write')
      .set('Authorization', 'Bearer viewer')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN_PERMISSION');
  });

  it('/auth/me advertises every permission of the roles', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer tenant_admin')
      .expect(200);
    expect(res.body.permissions).toContain('document:approve');
    expect(res.body.permissions).toContain('tenant:manage');
  });
});
