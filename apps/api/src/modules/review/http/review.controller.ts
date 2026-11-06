import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { auditIp } from '../../../config/trusted-proxies';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import { ApproveService, type ApproveResult } from '../application/approve.service';
import { ReopenService, type ReopenResult } from '../application/reopen.service';
import { IF_MATCH_REQUIRED, parseIfMatch } from '../domain/if-match';

/** 428 when the header is missing or `*`: both would skip the comparison that protects the data. */
function requireVersion(ifMatch: string | undefined): number {
  const version = parseIfMatch(ifMatch);
  if (version === null) {
    throw new HttpException(
      { message: 'If-Match with the document version is required', code: IF_MATCH_REQUIRED },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
  return version;
}

@Controller('documents')
export class ReviewController {
  constructor(
    private readonly approval: ApproveService,
    private readonly reopening: ReopenService,
  ) {}

  /**
   * API.md: the body is the corrected Invoice and `If-Match: "<version>"` is the version the person
   * reviewed. A stale version or a document already approved is 409 and nothing is written.
   */
  @RequirePermission('document:approve')
  @HttpCode(HttpStatus.OK)
  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApproveResult> {
    if (!req.user) throw new UnauthorizedException();
    return this.approval.approve({
      documentId: id,
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      ip: auditIp(req.ip),
      expectedVersion: requireVersion(ifMatch),
      body,
    });
  }

  /**
   * API.md: `approved -> needs_review`, version + 1. `If-Match` is the version the person saw; a
   * stale version or a document that is not approved is 409 and nothing is written.
   */
  @RequirePermission('document:approve')
  @HttpCode(HttpStatus.OK)
  @Post(':id/reopen')
  reopen(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ReopenResult> {
    if (!req.user) throw new UnauthorizedException();
    return this.reopening.reopen({
      documentId: id,
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      ip: auditIp(req.ip),
      expectedVersion: requireVersion(ifMatch),
    });
  }
}
