import { currentLogContext } from 'logger';
import { TenantDbService, type Db } from './tenant-db.service';

const ACME = '00000000-0000-4000-8000-0000000000a1';

/** A fake Drizzle whose transaction() records what ran and rolls back when the callback throws. */
function fakeDb() {
  const log: string[] = [];
  const db = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      log.push('begin');
      const tx = {
        execute: (q: unknown) => {
          log.push(JSON.stringify(q));
          return Promise.resolve();
        },
      };
      try {
        const out = await cb(tx);
        log.push('commit');
        return out;
      } catch (e) {
        log.push('rollback');
        throw e;
      }
    },
  };
  return { db: db as unknown as Db, log };
}

describe('TenantDbService', () => {
  it('sets app.tenant_id first in the transaction, with the id as a bound parameter', async () => {
    const { db, log } = fakeDb();
    await new TenantDbService(db).run(ACME, () => Promise.resolve());
    expect(log[0]).toBe('begin');
    expect(log[1]).toContain('set_config');
    expect(log[1]).toContain('app.tenant_id');
    expect(log[1]).toContain(ACME);
    expect(log[log.length - 1]).toBe('commit');
  });

  it('rolls back when the callback throws', async () => {
    const { db, log } = fakeDb();
    await expect(
      new TenantDbService(db).run(ACME, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(log).toContain('rollback');
  });

  it.each(['', 'acme', "x'; DROP TABLE tenants;--", `${ACME}0`])(
    'refuses a tenant id that is not a uuid (%j) before opening a transaction',
    async (bad) => {
      const { db, log } = fakeDb();
      await expect(new TenantDbService(db).run(bad, () => Promise.resolve())).rejects.toThrow(
        'Invalid tenant id',
      );
      expect(log).toEqual([]);
    },
  );

  it('current() returns the transaction inside run and throws outside it', async () => {
    const { db } = fakeDb();
    const svc = new TenantDbService(db);
    expect(() => svc.current()).toThrow('No tenant transaction');
    const inside = await svc.run(ACME, (tx) => Promise.resolve(svc.current() === tx));
    expect(inside).toBe(true);
    expect(() => svc.current()).toThrow('No tenant transaction');
  });

  it('runs afterCommit work once the transaction committed, in order', async () => {
    const { db, log } = fakeDb();
    const svc = new TenantDbService(db);
    await svc.run(ACME, () => {
      svc.afterCommit(() => {
        log.push('first');
      });
      svc.afterCommit(() => {
        log.push('second');
      });
      log.push('body');
      return Promise.resolve();
    });
    expect(log.slice(-4)).toEqual(['body', 'commit', 'first', 'second']);
  });

  it('drops afterCommit work when the transaction rolls back', async () => {
    const { db, log } = fakeDb();
    const svc = new TenantDbService(db);
    await expect(
      svc.run(ACME, () => {
        svc.afterCommit(() => {
          log.push('ran');
        });
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(log).not.toContain('ran');
  });

  it('a failing afterCommit step neither fails the committed run nor stops the next one', async () => {
    const { db, log } = fakeDb();
    const svc = new TenantDbService(db);
    const out = await svc.run(ACME, () => {
      svc.afterCommit(() => Promise.reject(new Error('redis down')));
      svc.afterCommit(() => {
        log.push('next');
      });
      return Promise.resolve(42);
    });
    expect(out).toBe(42);
    expect(log).toContain('next');
  });

  it('afterCommit outside run throws (fail closed)', () => {
    const { db } = fakeDb();
    expect(() => new TenantDbService(db).afterCommit(() => undefined)).toThrow(
      'No tenant transaction',
    );
  });

  it('keeps concurrent runs apart (each sees its own transaction)', async () => {
    const { db } = fakeDb();
    const svc = new TenantDbService(db);
    const seen = await Promise.all(
      [1, 2, 3].map((n) =>
        svc.run(ACME, async (tx) => {
          await new Promise((r) => setTimeout(r, 5 * (4 - n)));
          return svc.current() === tx;
        }),
      ),
    );
    expect(seen).toEqual([true, true, true]);
  });
});

describe('TenantDbService log context (T7.2)', () => {
  it('gives the work inside run the tenant, and nothing after it', async () => {
    const { db } = fakeDb();
    const seen = await new TenantDbService(db).run(ACME, async () => {
      await Promise.resolve();
      return currentLogContext().tenantId;
    });
    expect(seen).toBe(ACME);
    expect(currentLogContext().tenantId).toBeUndefined();
  });
});
