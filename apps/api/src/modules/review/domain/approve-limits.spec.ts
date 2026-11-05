import { readFileSync } from 'node:fs';
import path from 'node:path';
import { InvoiceSchema, type Invoice } from 'contracts';
import {
  MAX_APPROVED_LINES,
  MAX_APPROVED_TEXT,
  MAX_APPROVED_VAT_ROWS,
  withinApproveLimits,
} from './approve-limits';

const load = (): Invoice =>
  InvoiceSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(__dirname, '../../../../../../packages/contracts/fixtures/invoice.valid.json'),
        'utf8',
      ),
    ),
  );
const edit = (change: (invoice: Invoice) => void): Invoice => {
  const invoice = load();
  change(invoice);
  return invoice;
};

describe('withinApproveLimits', () => {
  it('accepts a normal invoice and one exactly at every limit', () => {
    expect(withinApproveLimits(load())).toBe(true);
    expect(
      withinApproveLimits(
        edit((i) => {
          i.lines = Array.from({ length: MAX_APPROVED_LINES }, () => i.lines[0]!);
          i.vatBreakdown = Array.from({ length: MAX_APPROVED_VAT_ROWS }, () => i.vatBreakdown[0]!);
          i.seller.name = 'x'.repeat(MAX_APPROVED_TEXT);
        }),
      ),
    ).toBe(true);
  });

  it.each<[string, (i: Invoice) => void]>([
    [
      'too many lines',
      (i) => (i.lines = Array.from({ length: MAX_APPROVED_LINES + 1 }, () => i.lines[0]!)),
    ],
    [
      'too many VAT rows',
      (i) =>
        (i.vatBreakdown = Array.from(
          { length: MAX_APPROVED_VAT_ROWS + 1 },
          () => i.vatBreakdown[0]!,
        )),
    ],
    ['a long seller name', (i) => (i.seller.name = 'x'.repeat(MAX_APPROVED_TEXT + 1))],
    ['a long buyer address', (i) => (i.buyer.address = 'x'.repeat(MAX_APPROVED_TEXT + 1))],
    [
      'a long line description',
      (i) => (i.lines[0]!.description = 'x'.repeat(MAX_APPROVED_TEXT + 1)),
    ],
    ['a long invoice number', (i) => (i.invoiceNo = 'x'.repeat(MAX_APPROVED_TEXT + 1))],
    ['NUL in a line unit', (i) => (i.lines[0]!.unit = 'k\u0000g')],
    ['NUL in the series', (i) => (i.series = 'C\u000026')],
  ])('refuses %s', (_name, change) => {
    expect(withinApproveLimits(edit(change))).toBe(false);
  });
});
