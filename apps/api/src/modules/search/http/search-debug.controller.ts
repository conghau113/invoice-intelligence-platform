import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiErrorCode } from 'contracts';
import { z } from 'zod';
import type { Env } from '../../../config/env.schema';
import { SkipTenantTransaction } from '../../../db/skip-tenant-transaction.decorator';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import {
  MAX_QUESTION_CHARS,
  MAX_TOP_K,
  RetrievalService,
  type RetrievalResult,
} from '../application/retrieval';

const debugBodySchema = z.strictObject({
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  topK: z.number().int().min(1).max(MAX_TOP_K).optional(),
});

/**
 * Internal debugging of hybrid retrieval (T5.3): the fused chunks with both ranks and raw scores,
 * to see why a chunk came first. Not a product feature and not in the web app: answered 404 in
 * production, and on the public demo the read-only guard refuses POST before this runs (no LLM
 * call, ADR 0018). POST so that the question stays out of URLs and access logs. The chunks are the
 * caller's own tenant's, behind the same permission as asking a question.
 */
@Controller('search')
export class SearchDebugController {
  private readonly production: boolean;

  constructor(
    private readonly retrieval: RetrievalService,
    config: ConfigService<Env, true>,
  ) {
    this.production = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  @RequirePermission('qa:ask')
  // Retrieval opens its own short transactions and waits on the AI service in between.
  @SkipTenantTransaction()
  @HttpCode(HttpStatus.OK)
  @Post('debug')
  debug(@Body() body: unknown, @Req() req: AuthenticatedRequest): Promise<RetrievalResult> {
    if (this.production) throw new NotFoundException();
    if (!req.user) throw new UnauthorizedException();
    const parsed = debugBodySchema.safeParse(body);
    if (!parsed.success) {
      // The zod message would quote the question.
      throw new BadRequestException({
        message: 'The request body is invalid',
        code: 'BODY_INVALID' satisfies ApiErrorCode,
      });
    }
    return this.retrieval.retrieve(req.user.tenantId, parsed.data.question, {
      topK: parsed.data.topK,
    });
  }
}
