/**
 * GET /insights/extraction end to end: real guards, interceptor, approve/reopen routes and Postgres
 * (as the app role). Only token verification is stubbed. The spec's check is here: approve ->
 * reopen -> approve again counts each corrected field once, and a reopened document counts none.
 * The specs share one database, so every expectation is a difference from what the tenant showed
 * before the test. That holds only because `test:int` runs the specs one after the other
 * (`--runInBand`): run them in parallel and another spec's approvals would land between the two
 * reads of a test.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ExtractionInsightsSchema,
  InvoiceSchema,
  type ExtractionInsights,
  type Invoice,
} from 'contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { applyJsonBodyLimit } from '../src/common/http/json-body-limit';
import { ProblemDetailsFilter } from '../src/common/http/problem-details.filter';
import * as schema from '../src/db/schema';
import { DB, TenantDbService } from '../src/db/tenant-db.service';
import { TenantTransactionInterceptor } from '../src/db/tenant-transaction.interceptor';
import { TENANT_DIRECTORY } from '../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../src/modules/auth/application/token-verifier.port';
import { JwtAuthGuard } from '../src/modules/auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../src/modules/auth/http/permissions.guard';
import { InsightsModule } from '../src/modules/insights/insights.module';
import { ReviewModule } from '../src/modules/review/review.module';

const ACME = '00000000-0000-4000-8000-0000000000a1';
const GLOBEX = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-00000000f046';
const REPORTS = path.join(__dirname, '../../../eval/reports');

function requireVar(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: run "pnpm --filter api test:int"`);
  }
  return value;
}

const fixture = (): Invoice =>
  InvoiceSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(__dirname, '../../../packages/contracts/fixtures/invoice.valid.json'),
        'utf8',
      ),
    ),
  );

/** Copy of `invoice` with `change` applied. */
const edited = (invoice: Invoice, change: (i: Invoice) => void): Invoice => {
  const copy = structuredClone(invoice);
  change(copy);
  return copy;
};

describe('GET /insights/extraction (HTTP -> Postgres)', () => {
  let owner: Pool;
  let pool: Pool;
  let app: NestExpressApplication;

  interface SeedOptions {
    tenant?: string;
    source?: 'pdf' | 'image' | 'xml';
    data?: Invoice;
    costUsd?: string | null;
  }

  /** A document waiting for review with its extraction, inserted by the owner. */
  async function seed({
    tenant = ACME,
    source = 'pdf',
    data = fixture(),
    costUsd = null,
  }: SeedOptions = {}): Promise<{ id: string; extractionId: string; ai: Invoice }> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO documents (id, tenant_id, status, source_type, storage_key, content_hash, version, uploaded_by)
       VALUES ($1, $2, 'needs_review', $3, $4, $5, 1, $6)`,
      [id, tenant, source, `tenant/${tenant}/${id}`, randomBytes(32).toString('hex'), USER],
    );
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO extractions (tenant_id, document_id, document_version, source, data, latency_ms, cost_usd)
       VALUES ($1, $2, 1, $3, $4, 10, $5) RETURNING id`,
      [tenant, id, source, JSON.stringify(data), costUsd],
    );
    return { id, extractionId: rows[0]!.id, ai: data };
  }

  const as = (tenant: string) => (tenant === GLOBEX ? '@globex' : '');
  const approve = (id: string, body: Invoice, version: number, tenant = ACME) =>
    request(app.getHttpServer())
      .post(`/documents/${id}/approve`)
      .set('Authorization', `Bearer accountant${as(tenant)}`)
      .set('If-Match', `"${version}"`)
      .send(body)
      .expect(200);
  const reopen = (id: string, version: number) =>
    request(app.getHttpServer())
      .post(`/documents/${id}/reopen`)
      .set('Authorization', 'Bearer accountant')
      .set('If-Match', `"${version}"`)
      .send()
      .expect(200);

  /** What the page reads, checked against the shared contract. */
  async function insights(tenant = ACME, role = 'viewer'): Promise<ExtractionInsights> {
    const res = await request(app.getHttpServer())
      .get('/insights/extraction')
      .set('Authorization', `Bearer ${role}${as(tenant)}`)
      .expect(200);
    return ExtractionInsightsSchema.parse(res.body);
  }
  const docsOf = (i: ExtractionInsights, field: string) =>
    i.online.fields.find((f) => f.field === field)?.documents;
  /** The numbers a test moves, as a difference from `before`. */
  const delta = (before: ExtractionInsights, after: ExtractionInsights, fields: string[]) => ({
    approved: after.online.approvedDocuments - before.online.approvedDocuments,
    uncorrected: after.online.uncorrectedDocuments - before.online.uncorrectedDocuments,
    xml: after.online.excludedXmlDocuments - before.online.excludedXmlDocuments,
    ...Object.fromEntries(fields.map((f) => [f, docsOf(after, f)! - docsOf(before, f)!])),
  });
  const historyRows = async (extractionId: string) =>
    (
      await owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM field_corrections WHERE extraction_id = $1',
        [extractionId],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    owner = new Pool({ connectionString: requireVar('DATABASE_OWNER_URL'), max: 1 });
    pool = new Pool({ connectionString: requireVar('DATABASE_URL'), max: 4 });

    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: drizzle(pool, { schema }) },
        TenantDbService,
        { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
        // Global like the app's ConfigModule; InsightsModule reads EVAL_REPORTS_DIR from it.
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'EVAL_REPORTS_DIR' ? REPORTS : undefined) },
        },
      ],
      exports: [DB, TenantDbService, ConfigService],
    })
    class RealDbModule {}

    const mod = await Test.createTestingModule({
      imports: [RealDbModule, ReviewModule, InsightsModule],
      providers: [
        {
          provide: TOKEN_VERIFIER,
          useValue: {
            // Token "<role>" (tenant acme) or "<role>@<tenant alias>".
            verify: (token: string) => {
              const [role, alias = 'acme'] = token.split('@');
              return Promise.resolve({
                sub: USER,
                organization: [alias],
                realm_access: { roles: [role] },
              });
            },
          },
        },
        {
          provide: TENANT_DIRECTORY,
          useValue: { idForAlias: (a: string) => Promise.resolve(a === 'globex' ? GLOBEX : ACME) },
        },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    applyJsonBodyLimit(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    // Leave nothing behind for the specs that count rows. Children first (foreign keys).
    const mine = `SELECT id FROM documents WHERE uploaded_by = $1`;
    await owner.query(
      `DELETE FROM field_corrections WHERE extraction_id IN
         (SELECT id FROM extractions WHERE document_id IN (${mine}))`,
      [USER],
    );
    await owner.query(
      `DELETE FROM invoice_lines WHERE invoice_id IN
         (SELECT id FROM invoices WHERE document_id IN (${mine}))`,
      [USER],
    );
    await owner.query(`DELETE FROM invoices WHERE document_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM extractions WHERE document_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM audit_logs WHERE entity_id IN (${mine})`, [USER]);
    await owner.query(`DELETE FROM documents WHERE uploaded_by = $1`, [USER]);
    await Promise.all([owner.end(), pool.end()]);
  });

  it('approve -> reopen -> approve again: each corrected field counts once, none while reopened', async () => {
    const fields = ['invoiceNo', 'seller.name', 'total'];
    const start = await insights();
    const { id, extractionId, ai } = await seed();
    const corrected = edited(ai, (i) => {
      i.invoiceNo = 'FIXED-1';
      i.seller.name = 'SAMPLE Seller fixed';
    });

    await approve(id, corrected, 1);
    expect(delta(start, await insights(), fields)).toEqual({
      approved: 1,
      uncorrected: 0,
      xml: 0,
      invoiceNo: 1,
      'seller.name': 1,
      total: 0,
    });

    // Reopened: the document is not approved now, so it counts in neither numerator nor denominator.
    await reopen(id, 1);
    expect(delta(start, await insights(), fields)).toEqual({
      approved: 0,
      uncorrected: 0,
      xml: 0,
      invoiceNo: 0,
      'seller.name': 0,
      total: 0,
    });

    // Approved again with the same changes: the history now holds them twice...
    await approve(id, corrected, 2);
    expect(await historyRows(extractionId)).toBe(4);
    // ...and the rate still counts them once.
    expect(delta(start, await insights(), fields)).toEqual({
      approved: 1,
      uncorrected: 0,
      xml: 0,
      invoiceNo: 1,
      'seller.name': 1,
      total: 0,
    });
  });

  it('a change undone at the second approval stops counting', async () => {
    const start = await insights();
    const { id, ai } = await seed();
    await approve(
      id,
      edited(ai, (i) => (i.invoiceNo = 'FIXED-2')),
      1,
    );
    await reopen(id, 1);
    await approve(id, ai, 2);
    expect(delta(start, await insights(), ['invoiceNo'])).toEqual({
      approved: 1,
      uncorrected: 1,
      xml: 0,
      invoiceNo: 0,
    });
  });

  it('several changed cells of one line column count one document', async () => {
    const start = await insights();
    const base = fixture();
    const line = base.lines[0]!;
    const ai = edited(base, (i) => (i.lines = [line, { ...line }, { ...line }]));
    const { id } = await seed({ data: ai, source: 'image' });
    await approve(
      id,
      edited(ai, (i) => {
        i.lines[1]!.amount += 1;
        i.lines[2]!.amount += 1;
      }),
      1,
    );
    const after = await insights();
    expect(delta(start, after, ['lines.*.amount', 'lines.*.description'])).toEqual({
      approved: 1,
      uncorrected: 0,
      xml: 0,
      'lines.*.amount': 1,
      'lines.*.description': 0,
    });
    // Grouped in SQL: no field carries a row index.
    expect(after.online.fields.some((f) => /\.\d+\./.test(f.field))).toBe(false);
  });

  it('XML documents are left out of the rate and counted apart', async () => {
    const start = await insights();
    const { id, ai } = await seed({ source: 'xml' });
    await approve(
      id,
      edited(ai, (i) => (i.invoiceNo = 'XML-FIX')),
      1,
    );
    expect(delta(start, await insights(), ['invoiceNo'])).toEqual({
      approved: 0,
      uncorrected: 0,
      xml: 1,
      invoiceNo: 0,
    });
  });

  it('tenants see only their own numbers; cost is the mean of the reviewed extractions', async () => {
    const acmeBefore = await insights(ACME);
    const globexBefore = await insights(GLOBEX);
    // What the mean is built from before this test: approved AI documents of GLOBEX with a cost.
    const { rows } = await owner.query<{ n: number; sum: number }>(
      `SELECT count(e.cost_usd)::int AS n, coalesce(sum(e.cost_usd), 0)::float8 AS sum
         FROM current_invoices i JOIN documents d ON d.id = i.document_id
         JOIN extractions e ON e.document_id = d.id
        WHERE i.tenant_id = $1 AND d.source_type IN ('pdf', 'image')`,
      [GLOBEX],
    );
    const before = rows[0]!;
    // Two approved with a known cost, one with none: a missing cost is left out of the mean.
    for (const costUsd of ['0.004000', '0.002000', null]) {
      const { id, ai } = await seed({ tenant: GLOBEX, costUsd });
      await approve(
        id,
        edited(ai, (i) => (i.total += 1)),
        1,
        GLOBEX,
      );
    }
    const globex = await insights(GLOBEX);
    expect(delta(globexBefore, globex, ['total'])).toEqual({
      approved: 3,
      uncorrected: 0,
      xml: 0,
      total: 3,
    });
    expect(await insights(ACME)).toEqual(acmeBefore);
    expect(globex.online.costUsdPerDocument).toBeCloseTo((before.sum + 0.006) / (before.n + 2), 9);
  });

  it('carries the offline numbers of the committed eval report next to the online ones', async () => {
    const body = await insights();
    expect(body.offline?.documents).toBe(100);
    expect(body.offline?.model).toMatch(/\S/);
  });

  describe('who may read', () => {
    it.each(['viewer', 'accountant', 'tenant_admin'])('%s -> 200', async (role) => {
      await insights(ACME, role);
    });

    it('no token -> 401', async () => {
      await request(app.getHttpServer()).get('/insights/extraction').expect(401);
    });
  });
});
