import { Module } from '@nestjs/common';
import { DocumentStateModule } from '../documents/document-state.module';
import { AdminJobsService } from './application/admin-jobs.service';
import { AdminJobsController } from './http/admin-jobs.controller';
import { QueueModule } from './queue.module';

@Module({
  imports: [QueueModule, DocumentStateModule],
  controllers: [AdminJobsController],
  providers: [AdminJobsService],
})
export class QueueAdminModule {}
