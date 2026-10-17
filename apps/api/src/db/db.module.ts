import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Env } from '../config/env.schema';
import * as schema from './schema';
import { DB, TenantDbService } from './tenant-db.service';
import { TenantTransactionInterceptor } from './tenant-transaction.interceptor';

export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Pool => {
        const pool = new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: 10,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          statement_timeout: 15_000,
        });
        // An idle client erroring must not crash the process. Log the class only: pg messages
        // can include host and user names.
        pool.on('error', (err) => new Logger('Database').error(err.constructor.name));
        return pool;
      },
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool) => drizzle(pool, { schema }) },
    TenantDbService,
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
  exports: [PG_POOL, DB, TenantDbService],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
