import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { STORAGE_PORT, type StoragePort } from '../storage/application/storage.port';
import { StorageModule } from '../storage/storage.module';
import { DocumentStateMachine } from './application/document-state-machine';
import { DocumentsController } from './http/documents.controller';
import { StorageMulterEngine } from './infra/storage-multer-engine';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

@Module({
  imports: [
    StorageModule,
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
  providers: [DocumentStateMachine],
  exports: [DocumentStateMachine],
})
export class DocumentsModule {}
