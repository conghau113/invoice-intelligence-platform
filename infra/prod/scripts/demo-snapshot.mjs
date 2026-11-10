#!/usr/bin/env node
// Pre-processed demo data (T4.7, ADR 0018): the public demo makes no LLM calls, so documents are
// processed on the developer's machine and copied to the server as a snapshot.
//
//   export  (laptop, dev stack)  rows + files of the demo tenants' finished documents -> a folder
//   import  (server, superuser)  verify every file hash, write the files, insert the rows
//
// Only documents of the two synthetic demo tenants, only finished states, only those whose file
// exists, only those created after --since (the dev database also holds test uploads). Rows
// travel as JSON (Postgres json_agg / json_populate_recordset), so no extra dependency; `pg` is
// resolved from the API package the script runs next to (cwd).
//
// Usage (infra/prod/README.md, "Dữ liệu demo"):
//   cd apps/api && SOURCE_DATABASE_URL=... DATA_DIR=... \
//     node ../../infra/prod/scripts/demo-snapshot.mjs export <out-dir> --since <ISO time>
//   docker compose -f compose.prod.yaml --profile tools run --rm demo-import
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Synthetic tenants from apps/api/src/db/seed.ts (fixed Keycloak organization ids). */
export const DEMO_TENANT_IDS = [
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000a2',
];

/** States worth showing. uploaded/queued/processing would sit still: the demo has no live pipeline. */
export const EXPORTED_STATUSES = ['needs_review', 'approved', 'failed', 'rejected'];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORAGE_KEY = new RegExp(`^tenant/(${UUID})/(${UUID})$`);

/**
 * Tables in insert order (parents first) and how their rows are chosen from the selected document
 * ids ($1). `omit`: identity columns Postgres generates itself.
 */
export const TABLES = [
  { name: 'documents', where: 'id = ANY($1::uuid[])' },
  { name: 'extractions', where: 'document_id = ANY($1::uuid[])' },
  { name: 'invoices', where: 'document_id = ANY($1::uuid[])' },
  {
    name: 'invoice_lines',
    where: 'invoice_id IN (SELECT id FROM invoices WHERE document_id = ANY($1::uuid[]))',
  },
  {
    name: 'field_corrections',
    where: 'extraction_id IN (SELECT id FROM extractions WHERE document_id = ANY($1::uuid[]))',
  },
  { name: 'audit_logs', where: 'entity_id = ANY($1::uuid[])', omit: ['id'] },
];

/** The path of a storage key under `root`, or an error for anything but tenant/<uuid>/<uuid>. */
export function fileFor(root, key, tenantId) {
  const m = STORAGE_KEY.exec(key);
  if (m === null) throw new Error(`unexpected storage key format: ${JSON.stringify(key)}`);
  if (tenantId !== undefined && m[1] !== tenantId) {
    throw new Error(`storage key belongs to another tenant: ${key}`);
  }
  const base = resolve(root);
  const target = resolve(base, ...key.split('/'));
  if (!target.startsWith(base + sep)) throw new Error(`storage key escapes the root: ${key}`);
  return target;
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Checks a snapshot before anything is written: known tables only, every document of a demo
 * tenant, every file present with the recorded hash. Returns the documents' files to write.
 */
export async function verifySnapshot(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1) throw new Error('unknown snapshot version');
  const known = new Set(TABLES.map((t) => t.name));
  for (const name of Object.keys(manifest.tables)) {
    if (!known.has(name)) throw new Error(`unknown table in snapshot: ${name}`);
  }
  const documents = manifest.tables.documents ?? [];
  if (documents.length === 0) throw new Error('snapshot has no documents');
  for (const table of TABLES) {
    for (const row of manifest.tables[table.name] ?? []) {
      if (!DEMO_TENANT_IDS.includes(row.tenant_id)) {
        throw new Error(`${table.name} row of a tenant that is not a demo tenant`);
      }
    }
  }
  const files = [];
  for (const doc of documents) {
    const recorded = manifest.files[doc.storage_key];
    if (recorded === undefined) throw new Error(`no file recorded for document ${doc.id}`);
    const source = fileFor(join(dir, 'files'), doc.storage_key, doc.tenant_id);
    const bytes = await readFile(source);
    if (sha256(bytes) !== recorded.sha256) throw new Error(`hash mismatch for document ${doc.id}`);
    files.push({ key: doc.storage_key, tenantId: doc.tenant_id, bytes });
  }
  return { manifest, files };
}

function loadPg() {
  // The API package (cwd) has `pg`; the script itself lives outside any package.
  return createRequire(join(process.cwd(), 'package.json'))('pg');
}

function requireVar(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function assertSuperuser(client) {
  // RLS is forced on every business table; only a superuser sees and writes all demo rows.
  const { rows } = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if (rows[0]?.rolsuper !== true)
    throw new Error('connect as a superuser (RLS hides rows otherwise)');
}

/** The --since value as a Date; required, so test uploads from earlier work are never exported. */
export function parseSince(args) {
  const i = args.indexOf('--since');
  const value = i === -1 ? undefined : args[i + 1];
  const date = value === undefined ? undefined : new Date(value);
  if (date === undefined || Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error('export needs --since <ISO time>, e.g. --since 2026-11-10T08:00:00+07:00');
  }
  return date;
}

async function exportSnapshot(out, since) {
  const { Client } = loadPg();
  const dataDir = requireVar('DATA_DIR');
  const client = new Client({ connectionString: requireVar('SOURCE_DATABASE_URL') });
  await client.connect();
  try {
    await assertSuperuser(client);
    const { rows: candidates } = await client.query(
      `SELECT id, tenant_id, storage_key FROM documents
        WHERE tenant_id = ANY($1::uuid[]) AND status = ANY($2::text[]) AND created_at >= $3
        ORDER BY created_at`,
      [DEMO_TENANT_IDS, EXPORTED_STATUSES, since],
    );
    const files = {};
    const ids = [];
    for (const doc of candidates) {
      let bytes;
      try {
        bytes = await readFile(fileFor(dataDir, doc.storage_key, doc.tenant_id));
      } catch (e) {
        if (e?.code === 'ENOENT') continue; // seeded rows without a file (db:seed:documents)
        throw e;
      }
      const target = fileFor(join(out, 'files'), doc.storage_key, doc.tenant_id);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      files[doc.storage_key] = { sha256: sha256(bytes), bytes: bytes.length };
      ids.push(doc.id);
    }
    if (ids.length === 0) throw new Error('no finished demo document with a stored file');
    const tables = {};
    for (const table of TABLES) {
      const { rows } = await client.query(
        `SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM (SELECT * FROM ${table.name} WHERE ${table.where}) t`,
        [ids],
      );
      tables[table.name] = rows[0].rows;
    }
    const manifest = { version: 1, createdAt: new Date().toISOString(), tables, files };
    await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
    const counts = Object.entries(tables).map(([n, r]) => `${n}=${r.length}`);
    console.log(`exported ${ids.length} documents (${counts.join(', ')})`);
  } finally {
    await client.end();
  }
}

async function importSnapshot(dir) {
  const { Client } = loadPg();
  const dataDir = requireVar('DATA_DIR');
  const { manifest, files } = await verifySnapshot(dir);
  const client = new Client({ connectionString: requireVar('TARGET_DATABASE_URL') });
  await client.connect();
  // Files written by this run, removed again if the rows cannot be inserted: a failed import
  // leaves neither rows (ROLLBACK) nor orphan files, and can simply be run again.
  const written = [];
  try {
    await assertSuperuser(client);
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM documents WHERE tenant_id = ANY($1::uuid[])',
      [DEMO_TENANT_IDS],
    );
    if (rows[0].n > 0)
      throw new Error(
        'the demo tenants already have documents: import once, into an empty database',
      );
    for (const f of files) {
      const target = fileFor(dataDir, f.key, f.tenantId);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.bytes, { mode: 0o640 });
      written.push(target);
    }
    await client.query('BEGIN');
    for (const table of TABLES) {
      const data = manifest.tables[table.name] ?? [];
      if (data.length === 0) continue;
      const omit = new Set(table.omit ?? []);
      const { rows: cols } = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table.name],
      );
      const list = cols.map((c) => `"${c.column_name}"`).filter((c) => !omit.has(c.slice(1, -1)));
      await client.query(
        `INSERT INTO ${table.name} (${list.join(', ')})
         SELECT ${list.join(', ')} FROM json_populate_recordset(NULL::${table.name}, $1::json)`,
        [JSON.stringify(data)],
      );
    }
    await client.query('COMMIT');
    const counts = TABLES.map((t) => `${t.name}=${(manifest.tables[t.name] ?? []).length}`);
    console.log(`imported ${files.length} documents (${counts.join(', ')})`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    await Promise.all(written.map((p) => unlink(p).catch(() => undefined)));
    if (written.length > 0) console.error(`removed ${written.length} files written by this run`);
    throw e;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [command, dir] = args;
  if ((command !== 'export' && command !== 'import') || dir === undefined) {
    console.error(
      'Usage: demo-snapshot.mjs export <out-dir> --since <ISO time> | import <snapshot-dir>',
    );
    process.exit(2);
  }
  if (command === 'export') {
    const since = parseSince(args);
    await mkdir(dir, { recursive: true });
    if ((await readdir(dir)).length > 0) throw new Error('the output folder must be empty');
    await exportSnapshot(dir, since);
  } else {
    await importSnapshot(dir);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Message only: pg errors can carry connection details, never row values here.
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'failed');
    process.exit(1);
  });
}
