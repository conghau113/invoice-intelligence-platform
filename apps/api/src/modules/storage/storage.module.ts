import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { STORAGE_PORT } from './application/storage.port';
import { LocalFsStorage } from './infra/local-fs.storage';

/** Exported on its own so the worker (T2.4/T2.9) can read files without the HTTP controller. */
@Module({
  providers: [
    {
      provide: STORAGE_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new LocalFsStorage(config.get('DATA_DIR', { infer: true })),
    },
  ],
  exports: [STORAGE_PORT],
})
export class StorageModule {}
