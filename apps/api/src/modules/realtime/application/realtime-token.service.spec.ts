import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { REALTIME_TOKEN_TTL_S, RealtimeTokenService } from './realtime-token.service';

const SECRET = 'unit-test-realtime-secret-0123456789ab';
const USER = {
  userId: '00000000-0000-4000-8000-00000000a11c',
  tenantId: '00000000-0000-4000-8000-0000000000a1',
};
const key = (s: string) => new TextEncoder().encode(s);

describe('RealtimeTokenService', () => {
  const tokens = new RealtimeTokenService(SECRET);

  it('issues an HS256 token for the realtime audience that verifies back to the same user and tenant', async () => {
    const token = await tokens.issue(USER);

    expect(decodeProtectedHeader(token).alg).toBe('HS256');
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({ sub: USER.userId, tid: USER.tenantId, aud: 'realtime' });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(REALTIME_TOKEN_TTL_S);
    // Ids only: no roles, names or e-mail ride in a token the browser holds.
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub', 'tid']);
    await expect(tokens.verify(token)).resolves.toEqual(USER);
  });

  it('refuses a token issued with another key (another deployment, or a forged one)', async () => {
    const other = new RealtimeTokenService('another-secret-another-secret-0123456');
    await expect(tokens.verify(await other.issue(USER))).rejects.toThrow();
  });

  it.each([
    ['expired', { aud: 'realtime', exp: -120 }],
    ['for the REST audience', { aud: 'api', exp: 60 }],
  ])('refuses a token %s', async (_name, { aud, exp }) => {
    const token = await new SignJWT({ tid: USER.tenantId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER.userId)
      .setIssuer('invoice-api')
      .setAudience(aud)
      .setExpirationTime(Math.floor(Date.now() / 1000) + exp)
      .sign(key(SECRET));
    await expect(tokens.verify(token)).rejects.toThrow();
  });

  it('refuses a rightly signed token whose tenant is not a uuid', async () => {
    const token = await new SignJWT({ tid: 'acme' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER.userId)
      .setIssuer('invoice-api')
      .setAudience('realtime')
      .setExpirationTime('1m')
      .sign(key(SECRET));
    await expect(tokens.verify(token)).rejects.toThrow();
  });

  it('refuses an unsigned token (alg none)', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64({ alg: 'none' })}.${b64({ sub: USER.userId, tid: USER.tenantId, iss: 'invoice-api', aud: 'realtime', exp: now + 60 })}.`;
    await expect(tokens.verify(token)).rejects.toThrow();
  });
});
