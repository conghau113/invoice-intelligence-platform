import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { ExtractionInsights } from 'contracts';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import { InsightsService } from '../application/insights.service';

@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** API.md "Insights": correction rate per field and cost per document, with the eval numbers. */
  @RequirePermission('insights:read')
  @Get('extraction')
  extraction(@Req() req: AuthenticatedRequest): Promise<ExtractionInsights> {
    if (!req.user) throw new UnauthorizedException();
    return this.insights.extraction(req.user.tenantId);
  }
}
