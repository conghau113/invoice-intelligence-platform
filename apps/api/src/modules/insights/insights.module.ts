import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { EVAL_REPORTS_DIR, InsightsService } from './application/insights.service';
import { InsightsController } from './http/insights.controller';
import { InsightsRepository } from './infra/insights.repository';

/** AI numbers for /insights (T4.6): human correction rate and eval accuracy. Read-only. */
@Module({
  controllers: [InsightsController],
  providers: [
    InsightsService,
    InsightsRepository,
    {
      provide: EVAL_REPORTS_DIR,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('EVAL_REPORTS_DIR', { infer: true }),
    },
  ],
})
export class InsightsModule {}
