import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { SkipTenantTransaction } from '../../../db/skip-tenant-transaction.decorator';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import { DocumentsService, type DocumentView } from '../application/documents.service';
import { IDEMPOTENCY_KEY_REQUIRED, parseIdempotencyKey } from '../domain/idempotency';
import type { UploadedObject } from '../infra/storage-multer-engine';
import { IdempotencyKeyGuard } from './idempotency-key.guard';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * Streams the file to storage (multer engine, options in DocumentsModule), then registers it.
   * 201 when this call created the document, 200 when the same bytes or the same Idempotency-Key
   * had been seen (the existing document is returned and no new job may start). The request-wide
   * transaction is skipped: holding a connection while a client uploads would exhaust the pool, so
   * DocumentsService opens a short one after the file is on disk.
   */
  @RequirePermission('document:create')
  @SkipTenantTransaction()
  @UseGuards(IdempotencyKeyGuard)
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: UploadedObject | undefined,
    @Headers('idempotency-key') keyHeader: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentView> {
    if (!file) throw new BadRequestException('Expected one file in the "file" field');
    const idempotencyKey = parseIdempotencyKey(keyHeader);
    // The guard already refused this; kept so the type narrows without an assertion.
    if (!idempotencyKey || !req.user) {
      throw new BadRequestException({ message: 'Invalid request', code: IDEMPOTENCY_KEY_REQUIRED });
    }

    const result = await this.documents.create({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      ip: req.ip,
      idempotencyKey,
      file,
    });
    res.status(result.statusCode);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.document;
  }
}
