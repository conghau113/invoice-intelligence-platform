import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '../../config/env.schema';
import { TOKEN_VERIFIER } from './application/token-verifier.port';
import { JoseTokenVerifier } from './infra/jose-token-verifier';
import { AuthController } from './http/auth.controller';
import { JwtAuthGuard } from './http/jwt-auth.guard';

@Module({
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
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
