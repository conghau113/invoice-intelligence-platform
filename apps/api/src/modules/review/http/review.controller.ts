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
import { IF_MATCH_REQUIRED, parseIfMatch } from '../domain/if-match';

@Controller('documents')
export class ReviewController {
  constructor(private readonly approval: ApproveService) {}

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
    const expectedVersion = parseIfMatch(ifMatch);
    if (expectedVersion === null) {
      throw new HttpException(
        { message: 'If-Match with the document version is required', code: IF_MATCH_REQUIRED },
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    return this.approval.approve({
      documentId: id,
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      ip: auditIp(req.ip),
      expectedVersion,
      body,
    });
  }
}
