import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProblemDetailsFilter } from './common/http/problem-details.filter';
import { AuthModule } from './modules/auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { QueueAdminModule } from './modules/queue/queue-admin.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [ConfigModule, DbModule, AuthModule, HealthModule, DocumentsModule, QueueAdminModule],
  // Registered here (not in main.ts) so tests that boot AppModule exercise the real wiring.
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule {}
