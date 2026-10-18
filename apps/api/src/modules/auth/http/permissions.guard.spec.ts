import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ProblemDetailsFilter } from '../../../common/http/problem-details.filter';
import { TENANT_DIRECTORY } from '../application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../application/token-verifier.port';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { Public } from './public.decorator';
import { AnyAuthenticated, RequirePermission } from './require-permission.decorator';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACME_ID = '00000000-0000-4000-8000-0000000000a1';

@AnyAuthenticated()
@Controller('probe-class')
class ClassLevelProbeController {
  @Get('plain')
  plain(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('document:manage')
  @Get('strict')
  strict(): { ok: true } {
    return { ok: true };
  }
}

@Controller('probe')
class ProbeController {
  @RequirePermission('document:approve')
  @Post('approve')
  approve(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('document:read', 'document:manage')
  @Get('both')
  both(): { ok: true } {
    return { ok: true };
  }

  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }
}

describe('PermissionsGuard (real guards + filter, fake verifier)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // The fake verifier turns the bearer token "<role>[,<role>]" into claims.
    const verifier = {
      verify: (token: string) =>
        token === 'bad'
          ? Promise.reject(new Error('invalid'))
          : Promise.resolve({
              sub: USER_ID,
              organization: ['acme'],
              realm_access: { roles: token === 'none' ? [] : token.split(',') },
            }),
    };
    const mod = await Test.createTestingModule({
      controllers: [AuthController, ProbeController, ClassLevelProbeController],
      providers: [
        { provide: TOKEN_VERIFIER, useValue: verifier },
        {
          provide: TENANT_DIRECTORY,
          useValue: {
            idForAlias: (a: string) => Promise.resolve(a === 'acme' ? ACME_ID : undefined),
          },
        },
        { provide: ConfigService, useValue: {} },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  const call = (method: 'get' | 'post', path: string, token?: string) => {
    const req = request(app.getHttpServer())[method](path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('viewer calling approve -> 403 Problem Details naming the missing permission', async () => {
    const res = await call('post', '/probe/approve', 'viewer').expect(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      status: 403,
      title: 'Forbidden',
      detail: 'Missing permission: document:approve',
      code: 'FORBIDDEN_PERMISSION',
      instance: '/probe/approve',
    });
  });

  it('accountant and tenant_admin may approve', async () => {
    await call('post', '/probe/approve', 'accountant').expect(201);
    await call('post', '/probe/approve', 'tenant_admin').expect(201);
  });

  it('a user with no known role is refused', async () => {
    await call('post', '/probe/approve', 'none').expect(403);
    await call('post', '/probe/approve', 'god_mode').expect(403);
  });

  it('several permissions are all required', async () => {
    await call('get', '/probe/both', 'accountant').expect(403);
    await call('get', '/probe/both', 'tenant_admin').expect(200);
  });

  it('a route that declares nothing is denied even for admin (deny by default)', async () => {
    const res = await call('get', '/probe/undeclared', 'tenant_admin').expect(403);
    expect(res.body.code).toBe('FORBIDDEN_UNDECLARED');
  });

  it('a method-level permission is not bypassed by a class-level @AnyAuthenticated', async () => {
    await call('get', '/probe-class/plain', 'viewer').expect(200);
    await call('get', '/probe-class/strict', 'viewer').expect(403);
    await call('get', '/probe-class/strict', 'tenant_admin').expect(200);
  });

  it('authentication still comes first: no or bad token -> 401, not 403', async () => {
    await call('post', '/probe/approve').expect(401);
    await call('post', '/probe/approve', 'bad').expect(401);
  });

  it('@Public stays open and /auth/me works for any logged-in user with its permissions', async () => {
    await call('get', '/probe/open').expect(200);
    const res = await call('get', '/auth/me', 'viewer').expect(200);
    expect(res.body.permissions).toEqual(['document:read', 'qa:ask', 'insights:read']);
  });
});
