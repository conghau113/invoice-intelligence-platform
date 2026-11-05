import { readFileSync } from 'node:fs';
import path from 'node:path';
import { InvoiceSchema, type Invoice } from 'contracts';
import { diffInvoice } from './diff-invoice';

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

describe('diffInvoice', () => {
  it('reports nothing when the person changed nothing', () => {
    expect(diffInvoice(load(), load())).toEqual([]);
  });

  it('ignores fieldMeta: it describes the extraction', () => {
    expect(
      diffInvoice(
        load(),
        edit((i) => (i.fieldMeta = {})),
      ),
    ).toEqual([]);
  });

  it.each<[string, (i: Invoice) => void, string, unknown]>([
    ['a text field', (i) => (i.invoiceNo = 'X-1'), 'invoiceNo', 'X-1'],
    ['a nested field', (i) => (i.seller.name = 'SAMPLE B'), 'seller.name', 'SAMPLE B'],
    ['a total', (i) => (i.total = 7), 'total', 7],
    ['a line field', (i) => (i.lines[0]!.amount = 9), 'lines.0.amount', 9],
    ['a VAT field', (i) => (i.vatBreakdown[0]!.rate = 5), 'vatBreakdown.0.rate', 5],
  ])('finds a change to %s, with both values', (_name, change, fieldPath, humanValue) => {
    const ai = load();
    const out = diffInvoice(ai, edit(change));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fieldPath, humanValue });
    expect(out[0]!.aiValue).not.toEqual(humanValue);
  });

  it('a buyer tax code removed or added is a change to or from null', () => {
    const withCode = edit((i) => (i.buyer.taxCode = '0100000002'));
    const withoutCode = edit((i) => (i.buyer.taxCode = null));
    expect(diffInvoice(withCode, withoutCode)).toEqual([
      { fieldPath: 'buyer.taxCode', aiValue: '0100000002', humanValue: null },
    ]);
    expect(diffInvoice(withoutCode, withCode)).toEqual([
      { fieldPath: 'buyer.taxCode', aiValue: null, humanValue: '0100000002' },
    ]);
  });

  it('a line the person added has every field coming from null', () => {
    const ai = load();
    const n = ai.lines.length;
    const line = {
      description: 'SAMPLE',
      quantity: 2,
      unit: 'cái',
      unitPrice: 5,
      vatRate: 8,
      amount: 10,
    };
    const out = diffInvoice(
      ai,
      edit((i) => i.lines.push(line)),
    );
    expect(out).toEqual(
      Object.entries(line).map(([field, humanValue]) => ({
        fieldPath: `lines.${n}.${field}`,
        aiValue: null,
        humanValue,
      })),
    );
  });

  it('a line the person removed has every field going to null', () => {
    const ai = edit((i) => i.lines.push({ ...i.lines[0]! }));
    const last = ai.lines.length - 1;
    const out = diffInvoice(ai, load());
    expect(out.map((c) => c.fieldPath)).toEqual(
      ['description', 'quantity', 'unit', 'unitPrice', 'vatRate', 'amount'].map(
        (f) => `lines.${last}.${f}`,
      ),
    );
    expect(out.every((c) => c.humanValue === null)).toBe(true);
  });

  it('matches lines by position: removing the first line reports the shift (known limit, T4.6)', () => {
    const ai = edit((i) => {
      i.lines = [
        { ...i.lines[0]!, description: 'A' },
        { ...i.lines[0]!, description: 'B' },
      ];
    });
    const human = edit((i) => {
      i.lines = [{ ...i.lines[0]!, description: 'B' }];
    });
    const paths = diffInvoice(ai, human).map((c) => c.fieldPath);
    expect(paths).toContain('lines.0.description');
    expect(paths).toContain('lines.1.description');
  });
});
