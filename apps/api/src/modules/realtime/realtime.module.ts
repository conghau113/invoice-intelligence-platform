import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { RealtimeTokenService } from './application/realtime-token.service';
import { RealtimeController } from './http/realtime.controller';
import {
  REALTIME_MAX_CONNECTION_MS,
  REALTIME_TOKENS,
  RealtimeGateway,
} from './http/realtime.gateway';

/**
 * The API side of realtime (T6.4): the token route and the Socket.IO gateway. Its server is built by
 * RealtimeIoAdapter (main.ts), which adds the Redis adapter for running several instances.
 */
@Module({
  controllers: [RealtimeController],
  providers: [
    {
      provide: REALTIME_TOKENS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const secret = config.get('REALTIME_TOKEN_SECRET', { infer: true });
        return secret === undefined ? null : new RealtimeTokenService(secret);
      },
    },
    {
      provide: REALTIME_MAX_CONNECTION_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('REALTIME_MAX_CONNECTION_MS', { infer: true }) ?? 900_000,
    },
    RealtimeGateway,
  ],
})
export class RealtimeModule {}
