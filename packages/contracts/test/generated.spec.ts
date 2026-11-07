import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvoiceSchema, checkInvoice, todayInVietnam } from '../src';

// Samples from the synthetic invoice generator (tools/invoice-gen, T4.1). A test in apps/ai compares
// them with what the generator produces, so together they prove in CI, without a browser, that the
// generated ground truth still passes the real schema and rules.
const DIR = join(__dirname, '..', 'fixtures', 'generated');
const names = readdirSync(DIR).filter((n) => n.endsWith('.expected.json'));

describe('generated ground truth', () => {
  it('has the 10 samples, so an empty folder cannot pass', () => {
    expect(names).toHaveLength(10);
  });

  it.each(names)('%s is an invoice with no rule warning', (name) => {
    const invoice = InvoiceSchema.parse(JSON.parse(readFileSync(join(DIR, name), 'utf8')));
    expect(checkInvoice(invoice, todayInVietnam(new Date()))).toEqual([]);
  });
});
