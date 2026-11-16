import { Controller, HttpCode, Inject, NotFoundException, Optional, Post } from '@nestjs/common';
import type { RealtimeToken } from 'contracts';
import { SkipTenantTransaction } from '../../../db/skip-tenant-transaction.decorator';
import type { AuthUser } from '../../auth/domain/auth-user';
import { CurrentUser } from '../../auth/http/current-user.decorator';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import { RateLimit } from '../../rate-limit/http/rate-limit.decorator';
import {
  REALTIME_TOKEN_TTL_S,
  type RealtimeTokenService,
} from '../application/realtime-token.service';
import { REALTIME_TOKENS } from './realtime.gateway';

@Controller('realtime')
export class RealtimeController {
  constructor(
    @Optional() @Inject(REALTIME_TOKENS) private readonly tokens: RealtimeTokenService | null,
  ) {}

  /**
   * A handshake token for the socket of the current tenant (X-Tenant, checked by JwtAuthGuard).
   * Called by the web server (BFF), which holds the access token; the browser gets only this.
   * `document:read`: the stream tells which documents change, which is what reading the list shows.
   * POST so it is never cached; on the read-only demo it is refused like any write (no realtime).
   */
  @RequirePermission('document:read')
  @RateLimit('read')
  @SkipTenantTransaction()
  @Post('token')
  @HttpCode(200)
  async token(@CurrentUser() user: AuthUser): Promise<RealtimeToken> {
    // Realtime off (no REALTIME_TOKEN_SECRET): the web treats 404 as "keep polling".
    if (this.tokens === null) throw new NotFoundException();
    return { token: await this.tokens.issue(user), expiresIn: REALTIME_TOKEN_TTL_S };
  }
}
