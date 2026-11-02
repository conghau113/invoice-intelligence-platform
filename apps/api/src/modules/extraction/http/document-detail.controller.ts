import { Controller, Get, Param } from '@nestjs/common';
import { RequirePermission } from '../../auth/http/require-permission.decorator';
import { DocumentDetailService, type DocumentDetail } from '../application/document-detail.service';

@Controller('documents')
export class DocumentDetailController {
  constructor(private readonly detail: DocumentDetailService) {}

  /** A plain read: it uses the request-wide tenant transaction like the list does. */
  @RequirePermission('document:read')
  @Get(':id')
  get(@Param('id') id: string): Promise<DocumentDetail> {
    return this.detail.get(id);
  }
}
