/**
 * In-app notifications (T6.5) against a REAL Postgres as the app role: written by the real
 * DocumentStateMachine in the transition's transaction, read and marked through HTTP with the real
 * guards. Covers both halves of delivery: the row (offline) and the push after COMMIT (online).
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotificationPageSchema } from 'contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import * as schema from '../src/db/schema';
import { TenantDbService } from '../src/db/tenant-db.service';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { NO_CACHE_INVALIDATION } from '../src/modules/cache/application/tenant-read-cache';
import { DocumentStateMachine } from '../src/modules/documents/application/document-state-machine';
import { StoredDocumentNotifier } from '../src/modules/notifications/application/stored-document-notifier';
import { NotificationsModule } from '../src/modules/notifications/notifications.module';
import type {
  RealtimeEvent,
  RealtimePublisher,
} from '../src/modules/realtime/application/realtime-publisher.port';
import { realDbModule, stubAuthProviders, withoutCache } from './support/test-app';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const UPLOADER = '00000000-0000-4000-8000-00000000f051';
const COLLEAGUE = '00000000-0000-4000-8000-00000000f052';
const DOC_A = '00000000-0000-4000-8000-0000000d0051';
const DOC_B = '00000000-0000-4000-8000-0000000d0052';
const DOC_G = '00000000-0000-4000-8000-0000000d0053';

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

interface Pushed {
  tenantId: string;
  userId: string;
  event: RealtimeEvent;
}

describe('notifications (state machine -> Postgres -> HTTP)', () => {
  let owner: Pool;
  let pool: Pool;
  let tenantDb: TenantDbService;
  let machine: DocumentStateMachine;
  let app: INestApplication;
  const pushed: Pushed[] = [];

  const recording: RealtimePublisher = {
    toTenant: () => undefined,
    toUser: (tenantId, userId, event) => pushed.push({ tenantId, userId, event }),
  };

  const insertDoc = (id: string, tenant: string, status: string) =>
    owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, uploaded_by)
       VALUES ($1, $2, $3, 'xml', 'tenant/x/y', $4, $5)`,
      [id, tenant, status, id.replaceAll('-', '').padEnd(64, '0'), UPLOADER],
    );
  const rowsOf = async (doc: string) =>
    (
      await owner.query(
        'SELECT tenant_id, user_id, kind, failure_code, read_at FROM notifications WHERE document_id = $1',
        [doc],
      )
    ).rows;
  /** Token "<user>@<tenant alias>": that user, as an accountant, in that tenant. */
  const get = (who: string, alias = 'acme', query = '') =>
    request(app.getHttpServer())
      .get(`/notifications${query}`)
      .set('Authorization', `Bearer ${who}@${alias}`);
  const post = (who: string, path: string, alias = 'acme') =>
    request(app.getHttpServer())
      .post(`/notifications${path}`)
      .set('Authorization', `Bearer ${who}@${alias}`);
  /** processing -> needs_review (or failed) as the worker does it, in a tenant transaction. */
  const finish = (doc: string, tenant: string, to: 'needs_review' | 'failed', code?: string) =>
    tenantDb.run(tenant, () =>
      machine.transition(doc, to, { actorId: null, ...(code ? { code } : {}) }),
    );

  async function clean() {
    const docs = [DOC_A, DOC_B, DOC_G];
    await owner.query('DELETE FROM notifications WHERE document_id = ANY($1)', [docs]);
    await owner.query("DELETE FROM audit_logs WHERE entity = 'document' AND entity_id = ANY($1)", [
      docs,
    ]);
    await owner.query('DELETE FROM documents WHERE id = ANY($1)', [docs]);
  }

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 4 });
    tenantDb = new TenantDbService(drizzle(pool, { schema }));
    machine = new DocumentStateMachine(
      tenantDb,
      NO_CACHE_INVALIDATION,
      undefined,
      new StoredDocumentNotifier(tenantDb, recording),
    );

    const mod = await withoutCache(
      Test.createTestingModule({
        imports: [realDbModule(pool, {}), NotificationsModule],
        providers: stubAuthProviders(UPLOADER, { acme: ACME, globex: GLOBEX }),
      }),
    )
      .overrideProvider(TOKEN_VERIFIER)
      .useValue({
        verify: (token: string) => {
          const [sub, alias] = token.split('@');
          return Promise.resolve({
            sub,
            organization: [alias],
            realm_access: { roles: ['accountant'] },
          });
        },
      })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await clean();
    await Promise.all([owner.end(), pool.end()]);
  });
  beforeEach(async () => {
    await clean();
    pushed.length = 0;
    await insertDoc(DOC_A, ACME, 'processing');
    await insertDoc(DOC_B, ACME, 'processing');
    await insertDoc(DOC_G, GLOBEX, 'processing');
  });

  describe('writing (in the transition transaction)', () => {
    it('stores one notification for the uploader and pushes it to their room after COMMIT', async () => {
      await finish(DOC_A, ACME, 'needs_review');

      const rows = await rowsOf(DOC_A);
      expect(rows).toEqual([
        {
          tenant_id: ACME,
          user_id: UPLOADER,
          kind: 'extraction_succeeded',
          failure_code: null,
          read_at: null,
        },
      ]);
      expect(pushed).toEqual([
        {
          tenantId: ACME,
          userId: UPLOADER,
          event: {
            name: 'notification.created',
            payload: { id: expect.any(String), kind: 'extraction_succeeded', documentId: DOC_A },
          },
        },
      ]);
    });

    it('keeps the failure code of a failed extraction', async () => {
      await finish(DOC_A, ACME, 'failed', 'PDF_INVALID');

      expect(await rowsOf(DOC_A)).toEqual([
        expect.objectContaining({ kind: 'extraction_failed', failure_code: 'PDF_INVALID' }),
      ]);
    });

    it('stores nothing and pushes nothing when the transaction rolls back', async () => {
      await expect(
        tenantDb.run(ACME, async () => {
          await machine.transition(DOC_A, 'needs_review', { actorId: null });
          throw new Error('the job failed after the transition');
        }),
      ).rejects.toThrow('the job failed after the transition');

      expect(await rowsOf(DOC_A)).toEqual([]);
      expect(pushed).toEqual([]);
      expect(
        (await owner.query('SELECT status FROM documents WHERE id = $1', [DOC_A])).rows,
      ).toEqual([{ status: 'processing' }]);
    });

    it('stores nothing for a status change that is not the end of an extraction', async () => {
      await finish(DOC_A, ACME, 'needs_review');
      await tenantDb.run(ACME, () => machine.transition(DOC_A, 'approved', { actorId: UPLOADER }));

      expect(await rowsOf(DOC_A)).toHaveLength(1);
      expect(pushed).toHaveLength(1);
    });
  });

  describe('reading over HTTP (the offline half)', () => {
    it('lists the newest first with the unread count, in the contract shape', async () => {
      await finish(DOC_A, ACME, 'failed', 'PDF_INVALID');
      await finish(DOC_B, ACME, 'needs_review');

      const res = await get(UPLOADER).expect(200);

      const page = NotificationPageSchema.parse(res.body);
      expect(page.items.map((n) => [n.documentId, n.kind])).toEqual([
        [DOC_B, 'extraction_succeeded'],
        [DOC_A, 'extraction_failed'],
      ]);
      expect(page.unreadCount).toBe(2);
      expect(page.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    });

    it('pages with page and limit (ADR 0019)', async () => {
      await finish(DOC_A, ACME, 'needs_review');
      await finish(DOC_B, ACME, 'needs_review');

      const res = await get(UPLOADER, 'acme', '?page=2&limit=1').expect(200);

      expect(res.body.items.map((n: { documentId: string }) => n.documentId)).toEqual([DOC_A]);
      expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
      expect(res.body.unreadCount).toBe(2);
    });

    it('refuses a bad query with 400 INVALID_QUERY', async () => {
      const res = await get(UPLOADER, 'acme', '?limit=500').expect(400);
      expect(res.body.code).toBe('INVALID_QUERY');
    });

    it('marks one as read, idempotently, and the count follows', async () => {
      await finish(DOC_A, ACME, 'needs_review');
      await finish(DOC_B, ACME, 'needs_review');
      const id = (await get(UPLOADER).expect(200)).body.items[0].id as string;

      await post(UPLOADER, `/${id}/read`).expect(204);
      const firstReadAt = (
        await owner.query('SELECT read_at FROM notifications WHERE id = $1', [id])
      ).rows[0].read_at;
      await post(UPLOADER, `/${id}/read`).expect(204);

      const after = (await get(UPLOADER).expect(200)).body;
      expect(after.unreadCount).toBe(1);
      expect(after.items[0].readAt).not.toBeNull();
      // The second call did not move the time the user first read it.
      expect(
        (await owner.query('SELECT read_at FROM notifications WHERE id = $1', [id])).rows[0]
          .read_at,
      ).toEqual(firstReadAt);
    });

    it('marks all as read', async () => {
      await finish(DOC_A, ACME, 'needs_review');
      await finish(DOC_B, ACME, 'failed');

      await post(UPLOADER, '/read-all').expect(204);

      expect((await get(UPLOADER).expect(200)).body.unreadCount).toBe(0);
    });

    it('answers 400 for an id that is not a uuid', async () => {
      await post(UPLOADER, '/not-a-uuid/read').expect(400);
    });
  });

  describe('isolation', () => {
    it("a colleague in the same tenant neither sees nor marks the uploader's notifications", async () => {
      await finish(DOC_A, ACME, 'needs_review');
      const id = (await get(UPLOADER).expect(200)).body.items[0].id as string;

      const theirs = (await get(COLLEAGUE).expect(200)).body;
      expect(theirs.items).toEqual([]);
      expect(theirs.unreadCount).toBe(0);
      await post(COLLEAGUE, `/${id}/read`).expect(404);
      await post(COLLEAGUE, '/read-all').expect(204);

      expect((await get(UPLOADER).expect(200)).body.unreadCount).toBe(1);
    });

    it('the same user in another tenant sees only that tenant', async () => {
      await finish(DOC_A, ACME, 'needs_review');
      await finish(DOC_G, GLOBEX, 'needs_review');
      const acmeId = (await get(UPLOADER).expect(200)).body.items[0].id as string;

      const globex = (await get(UPLOADER, 'globex').expect(200)).body;
      expect(globex.items.map((n: { documentId: string }) => n.documentId)).toEqual([DOC_G]);
      await post(UPLOADER, `/${acmeId}/read`, 'globex').expect(404);
      await post(UPLOADER, '/read-all', 'globex').expect(204);

      expect((await get(UPLOADER).expect(200)).body.unreadCount).toBe(1);
    });

    it('the app role may update read_at only, and RLS hides other tenants', async () => {
      await finish(DOC_A, ACME, 'needs_review');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [GLOBEX]);
        const seen = await c.query('SELECT id FROM notifications WHERE document_id = $1', [DOC_A]);
        expect(seen.rows).toEqual([]);
        await expect(c.query('UPDATE notifications SET user_id = $1', [COLLEAGUE])).rejects.toThrow(
          /permission denied/,
        );
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await expect(c.query('DELETE FROM notifications')).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });
});
