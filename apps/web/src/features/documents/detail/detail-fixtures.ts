import { readFileSync } from 'node:fs';
import path from 'node:path';

/** A fresh copy of the Invoice the contracts tests use (valid, with fieldMeta), so a test may change it. */
export const loadInvoiceFixture = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      path.join(__dirname, '../../../../../../packages/contracts/fixtures/invoice.valid.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
