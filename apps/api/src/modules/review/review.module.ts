import { Module } from '@nestjs/common';
import { DocumentStateModule } from '../documents/document-state.module';
import { ApproveService } from './application/approve.service';
import { ReopenService } from './application/reopen.service';
import { ReviewController } from './http/review.controller';

/** Human-in-the-loop: approving a document, with what the person changed, and reopening it. */
@Module({
  imports: [DocumentStateModule],
  controllers: [ReviewController],
  providers: [ApproveService, ReopenService],
})
export class ReviewModule {}
