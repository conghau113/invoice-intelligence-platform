import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { AuthUser } from '../../auth/domain/auth-user';

/** Who a socket belongs to, from a verified handshake token. */
export interface RealtimeIdentity {
  userId: string;
  tenantId: string;
}

/** Long enough for the browser to open the socket after fetching it; useless soon after. */
export const REALTIME_TOKEN_TTL_S = 60;
const ISSUER = 'invoice-api';
const AUDIENCE = 'realtime';

const ClaimsSchema = z.object({ sub: z.uuid(), tid: z.uuid() });

/**
 * Short-lived handshake tokens for the Socket.IO gateway (ADR 0006: the browser never holds the
 * Keycloak access token). HS256 with a key only the API instances know, so any instance can check
 * a token another one issued. `aud=realtime`: the REST guard (RS256, Keycloak issuer, aud=api)
 * refuses it, and this check refuses a Keycloak token. It opens a socket and nothing else.
 */
export class RealtimeTokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(user: Pick<AuthUser, 'userId' | 'tenantId'>): Promise<string> {
    return new SignJWT({ tid: user.tenantId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime(`${REALTIME_TOKEN_TTL_S}s`)
      .sign(this.key);
  }

  /** Resolves with the identity of a valid token; rejects for ANY invalid one (reason not exposed). */
  async verify(token: string): Promise<RealtimeIdentity> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'sub'],
      clockTolerance: 5,
    });
    const claims = ClaimsSchema.parse(payload);
    return { userId: claims.sub, tenantId: claims.tid };
  }
}
