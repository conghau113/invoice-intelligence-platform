import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { TokenClaims, TokenVerifier } from '../application/token-verifier.port';

export interface JoseVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** Min gap between JWKS refetches triggered by unknown kids (default 30s). */
  cooldownMs?: number;
}

/**
 * Verifies RS256 JWTs against the issuer's JWKS. jose caches the key set in memory and refetches
 * (rate-limited by cooldown) only when a token names an unknown `kid` - that is how key rotation
 * is picked up without calling Keycloak on every request.
 */
export class JoseTokenVerifier implements TokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: JoseVerifierOptions) {
    this.keys = createRemoteJWKSet(new URL(options.jwksUrl), {
      cooldownDuration: options.cooldownMs ?? 30_000,
      cacheMaxAge: 600_000,
    });
  }

  async verify(token: string): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      algorithms: ['RS256'], // blocks alg=none and HS256 key-confusion
      clockTolerance: 5,
    });
    return payload;
  }
}
