import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { STORAGE_PORT, type StoragePort } from '../storage/application/storage.port';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentsService } from './application/documents.service';
import { DocumentStateModule } from './document-state.module';
import { DocumentsController } from './http/documents.controller';
import { StorageMulterEngine } from './infra/storage-multer-engine';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Module({
  imports: [
    StorageModule,
    QueueModule,
    DocumentStateModule,
    MulterModule.registerAsync({
      imports: [StorageModule],
      inject: [STORAGE_PORT],
      useFactory: (storage: StoragePort) => ({
        storage: new StorageMulterEngine(storage),
        limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      }),
    }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentStateModule, DocumentsService],
})
export class DocumentsModule {}
