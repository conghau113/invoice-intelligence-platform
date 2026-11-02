import { Module } from '@nestjs/common';
import { DocumentDetailService } from './application/document-detail.service';
import { DocumentDetailController } from './http/document-detail.controller';

/** The read side (HTTP): the document detail page's endpoint. The worker side is ExtractionWorkerModule. */
@Module({ controllers: [DocumentDetailController], providers: [DocumentDetailService] })
export class ExtractionModule {}
