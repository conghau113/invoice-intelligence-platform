import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isUuid } from '../common/uuid';
import type * as schema from './schema';

export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The only way application code touches tenant data. `run` opens a transaction, sets
 * `app.tenant_id` for that transaction only (set_config(..., true) = SET LOCAL, so a pooled
 * connection never keeps a previous tenant) and hands out the transaction. The request
 * interceptor, workers (T2.4) and retrieval (T5.3) all go through it.
 */
@Injectable()
export class TenantDbService {
  private readonly scope = new AsyncLocalStorage<Tx>();

  constructor(@Inject(DB) private readonly db: Db) {}

  async run<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return this.scope.run(tx, () => fn(tx));
    });
  }

  /** The transaction of the current request/job. Throws outside `run` (fail closed). */
  current(): Tx {
    const tx = this.scope.getStore();
    if (tx === undefined) throw new Error('No tenant transaction in this context');
    return tx;
  }
}
