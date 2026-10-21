import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { HealthController } from './http/health.controller';

@Module({ imports: [QueueModule], controllers: [HealthController] })
export class HealthModule {}
