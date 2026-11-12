import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { QaAskBodySchema, type ApiErrorCode } from 'contracts';
import type { Response } from 'express';
import { SkipTenantTransaction } from '../../../db/skip-tenant-transaction.decorator';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import { QaService } from '../application/qa.service';
import { formatEvent, outcomeEvents } from './sse';

/**
 * POST /qa/ask (T5.4, API.md): a question in, Server-Sent Events out. POST so that the question
 * stays out of URLs and access logs.
 *
 * Verify first, then stream: the whole outcome (route, retrieval, answer, citation check or SQL) is
 * decided before the response starts. So a failure before that point is an ordinary Problem Details
 * answer (400, 503 AI_SERVICE_UNAVAILABLE), and nothing that reaches the user is ever retracted
 * (TASKS.md, Phát sinh of T5.1). The event format is that of a token stream, so streaming the
 * model's tokens later does not change the web (T5.5).
 *
 * No request-wide transaction (the interceptor would hold one while the model works, and its
 * `lastValueFrom` does not fit a streamed response): retrieval and the aggregate open their own.
 * On the public demo the read-only guard refuses POST before this runs (ADR 0018).
 */
@Controller('qa')
export class QaController {
  constructor(private readonly qa: QaService) {}

  @RequirePermission('qa:ask')
  @SkipTenantTransaction()
  @Post('ask')
  async ask(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    if (!req.user) throw new UnauthorizedException();
    const parsed = QaAskBodySchema.safeParse(body);
    if (!parsed.success) {
      // The zod message would quote the question.
      throw new BadRequestException({
        message: 'The request body is invalid',
        code: 'BODY_INVALID' satisfies ApiErrorCode,
      });
    }
    // The person closed the page or pressed stop: stop waiting on the model too.
    const cancel = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) cancel.abort();
    };
    res.on('close', onClose);
    try {
      const outcome = await this.qa.ask(req.user.tenantId, parsed.data.question, cancel.signal);
      if (cancel.signal.aborted) return;
      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      // no-transform: a compressing proxy would buffer the events.
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('x-accel-buffering', 'no');
      for (const event of outcomeEvents(outcome)) res.write(formatEvent(event));
      res.end();
    } catch (err) {
      if (cancel.signal.aborted) return; // nobody is listening for the error
      throw err;
    } finally {
      res.off('close', onClose);
    }
  }
}
