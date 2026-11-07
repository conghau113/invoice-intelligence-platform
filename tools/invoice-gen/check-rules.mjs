// `pnpm gen:invoices:verify`, second half: every ground truth must pass the real TypeScript schema
// and business rules with no warning. Python has neither the Zod schema nor `checkInvoice`.
// Usage: node tools/invoice-gen/check-rules.mjs [dataset-dir]. Needs `contracts` built.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { InvoiceSchema, checkInvoice, todayInVietnam } = require(
  join(here, '..', '..', 'packages', 'contracts', 'dist', 'index.js'),
);

const root = resolve(process.argv[2] ?? join(here, 'out'));
const { documents } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const today = todayInVietnam(new Date());

let problems = documents.length === 0 ? 1 : 0;
for (const { id } of documents) {
  const parsed = InvoiceSchema.safeParse(
    JSON.parse(readFileSync(join(root, `${id}.expected.json`), 'utf8')),
  );
  if (!parsed.success) {
    console.log(`${id} NOT_AN_INVOICE`);
    problems += 1;
    continue;
  }
  for (const warning of checkInvoice(parsed.data, today)) {
    console.log(`${id} ${warning.code}`); // a fixed code, no document content
    problems += 1;
  }
}
console.log(`documents=${documents.length} problems=${problems}`);
process.exitCode = problems === 0 ? 0 : 1;
