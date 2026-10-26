import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { InvoiceSchema } from './invoice';

// Every schema exported to Python is listed here; output is deterministic (no timestamps).
const schemas = { invoice: InvoiceSchema };

const outDir = join(__dirname);
mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    override: (ctx) => {
      // Dates stay strings with Zod's calendar-correct pattern. With `format: date` the Python
      // generator emits datetime.date, whose lax parsing accepts datetimes and epoch integers
      // and ignores the pattern. [0-9] instead of \d: see invoice.ts.
      if (ctx.jsonSchema.format === 'date' && typeof ctx.jsonSchema.pattern === 'string') {
        delete ctx.jsonSchema.format;
        ctx.jsonSchema.pattern = ctx.jsonSchema.pattern.replaceAll('\\d', '[0-9]');
      }
    },
  });
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
}
