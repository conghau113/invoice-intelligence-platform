import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mapClaimsToUser } from '../application/claims-mapper';
import { TENANT_DIRECTORY, type TenantDirectory } from '../application/tenant-directory.port';
import { TOKEN_VERIFIER, type TokenVerifier } from '../application/token-verifier.port';
import type { AuthenticatedRequest } from './authenticated-request';
import { IS_PUBLIC } from './public.decorator';

/** Global guard: deny by default. Only routes marked @Public() skip it. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(TENANT_DIRECTORY) private readonly tenants: TenantDirectory,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (token === undefined) throw new UnauthorizedException();

    let claims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      // Reason (expired, bad aud, bad signature...) is deliberately not exposed or logged.
      throw new UnauthorizedException();
    }
    // X-Tenant only selects among the tenants in the signed claim; mapClaimsToUser checks it.
    const chosen = req.headers['x-tenant'];
    const requestedAlias = typeof chosen === 'string' ? chosen : undefined;
    req.user = await mapClaimsToUser(claims, this.tenants, requestedAlias); // may throw 403
    return true;
  }
}
