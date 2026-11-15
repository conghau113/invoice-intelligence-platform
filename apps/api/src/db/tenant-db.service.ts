import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isUuid } from '../common/uuid';
import type * as schema from './schema';

export const DB = Symbol('DB');
/** true on the public demo (DEMO_READ_ONLY): every tenant transaction is READ ONLY. */
export const DB_READ_ONLY = Symbol('DB_READ_ONLY');
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Work to do once the transaction has committed (see `afterCommit`). */
export type AfterCommit = () => Promise<void> | void;

interface Scope {
  tx: Tx;
  afterCommit: AfterCommit[];
}

/**
 * The only way application code touches tenant data. `run` opens a transaction, sets
 * `app.tenant_id` for that transaction only (set_config(..., true) = SET LOCAL, so a pooled
 * connection never keeps a previous tenant) and hands out the transaction. The request
 * interceptor, workers (T2.4) and retrieval (T5.3) all go through it.
 *
 * With `readOnly` (the public demo, ADR 0018) the transaction is opened READ ONLY, so Postgres
 * itself refuses a write (SQLSTATE 25006) if one ever gets past DemoReadOnlyGuard. Second layer
 * only: the guard is what answers the client.
 */
@Injectable()
export class TenantDbService {
  private readonly scope = new AsyncLocalStorage<Scope>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(DB_READ_ONLY) private readonly readOnly: boolean = false,
  ) {}

  async run<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!isUuid(tenantId)) throw new Error('Invalid tenant id');
    const afterCommit: AfterCommit[] = [];
    const result = await this.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        return this.scope.run({ tx, afterCommit }, () => fn(tx));
      },
      this.readOnly ? { accessMode: 'read only' } : undefined,
    );
    // Only reached when COMMIT succeeded: a rollback rejects above and the list is dropped. Awaited,
    // so the caller (and the HTTP response) comes after the work, e.g. a cache invalidation that a
    // client's next read must see. A failure here cannot undo the commit, so it is not thrown.
    for (const work of afterCommit) {
      try {
        await work();
      } catch {
        // The registered work owns its error handling; nothing to add without leaking details.
      }
    }
    return result;
  }

  /**
   * Runs `work` after the current transaction commits, never if it rolls back. For side effects
   * outside Postgres that must not be seen before the data is (T6.3: invalidating the read cache
   * before COMMIT would let a concurrent reader cache the old rows again). Throws outside `run`.
   */
  afterCommit(work: AfterCommit): void {
    const scope = this.scope.getStore();
    if (scope === undefined) throw new Error('No tenant transaction in this context');
    scope.afterCommit.push(work);
  }

  /** The transaction of the current request/job. Throws outside `run` (fail closed). */
  current(): Tx {
    const scope = this.scope.getStore();
    if (scope === undefined) throw new Error('No tenant transaction in this context');
    return scope.tx;
  }
}
