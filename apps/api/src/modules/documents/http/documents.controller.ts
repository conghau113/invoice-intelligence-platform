import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import type { UploadedObject } from '../infra/storage-multer-engine';

@Controller('documents')
export class DocumentsController {
  /**
   * T2.1 only stores the file and reports what was stored; the documents row, dedupe by hash and
   * Idempotency-Key arrive in T2.2/T2.3. The multer options (size limit, engine) are set in
   * DocumentsModule, which owns the StoragePort wiring.
   */
  @RequirePermission('document:create')
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: UploadedObject | undefined): UploadedObject {
    if (!file) throw new BadRequestException('Expected one file in the "file" field');
    const { storageKey, size, sha256, sourceType } = file;
    return { storageKey, size, sha256, sourceType };
  }
}
