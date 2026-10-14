import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { InvoiceDraftSchema } from './invoice';

// Every schema exported to Python is listed here; output is deterministic (no timestamps).
const schemas = { 'invoice-draft': InvoiceDraftSchema };

const outDir = join(__dirname);
mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
}
