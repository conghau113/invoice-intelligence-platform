import { Module } from '@nestjs/common';
import { DocumentStateMachine } from './application/document-state-machine';

/** Separate from DocumentsModule so the worker can use the state machine without the HTTP/multer parts. */
@Module({ providers: [DocumentStateMachine], exports: [DocumentStateMachine] })
export class DocumentStateModule {}
