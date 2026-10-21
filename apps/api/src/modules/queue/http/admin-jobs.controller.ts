import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { isUuid } from '../../../common/uuid';
import { SkipTenantTransaction } from '../../../db/skip-tenant-transaction.decorator';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import type { AuthUser } from '../../auth/domain/auth-user';
import { AdminJobsService } from '../application/admin-jobs.service';

export interface FailedJobDto {
  id: string;
  documentId: string;
  attemptsMade: number | null;
  reason: string | null;
  failedAt: string;
}

/** The guard already refused anonymous calls; this narrows the type without an assertion. */
function userOf(req: AuthenticatedRequest): AuthUser {
  if (!req.user) throw new UnauthorizedException();
  return req.user;
}

/**
 * API.md "Admin (tenant_admin)": the job id is the document id (one job per document).
 * No request-wide transaction: these calls wait on Redis, and the service opens short ones itself.
 */
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly jobs: AdminJobsService) {}

  @RequirePermission('document:manage')
  @SkipTenantTransaction()
  @Get()
  async list(
    @Query('state') state: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: FailedJobDto[] }> {
    // Only the dead-letter set is listed; other states would need paging that nothing uses yet.
    if (state !== undefined && state !== 'failed') {
      throw new BadRequestException('Only state=failed is supported');
    }
    const jobs = await this.jobs.listFailed(userOf(req).tenantId);
    return {
      items: jobs.map((j) => ({
        id: j.documentId,
        documentId: j.documentId,
        attemptsMade: j.attemptsMade,
        reason: j.reason,
        failedAt: j.failedAt.toISOString(),
      })),
    };
  }

  @RequirePermission('document:manage')
  @SkipTenantTransaction()
  @Post(':id/retry')
  @HttpCode(202)
  async retry(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    if (!isUuid(id)) throw new BadRequestException('Invalid job id');
    const user = userOf(req);
    await this.jobs.retry(user.tenantId, user.userId, id);
  }
}
