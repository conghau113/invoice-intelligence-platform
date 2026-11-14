import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '../../config/env.schema';
import { RateLimitGuard } from '../rate-limit/http/rate-limit.guard';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { TENANT_DIRECTORY } from './application/tenant-directory.port';
import { TOKEN_VERIFIER } from './application/token-verifier.port';
import { PgTenantDirectory } from './infra/pg-tenant-directory';
import { JoseTokenVerifier } from './infra/jose-token-verifier';
import { AuthController } from './http/auth.controller';
import { DemoReadOnlyGuard } from './http/demo-read-only.guard';
import { JwtAuthGuard } from './http/jwt-auth.guard';
import { PermissionsGuard } from './http/permissions.guard';

@Module({
  imports: [RateLimitModule],
  controllers: [AuthController],
  providers: [
    {
      provide: TOKEN_VERIFIER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const issuer = config.get('OIDC_ISSUER_URL', { infer: true });
        return new JoseTokenVerifier({
          issuer,
          audience: config.get('OIDC_AUDIENCE', { infer: true }),
          jwksUrl:
            config.get('OIDC_JWKS_URL', { infer: true }) ??
            `${issuer}/protocol/openid-connect/certs`,
        });
      },
    },
    { provide: TENANT_DIRECTORY, useClass: PgTenantDirectory },
    // Order matters: the demo's read-only rule first (it does not depend on who is calling),
    // then authenticate, then authorize, then rate limit (only a caller allowed to use the route
    // spends a token, so nobody can drain another user's bucket with refused requests).
    { provide: APP_GUARD, useClass: DemoReadOnlyGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AuthModule {}
