import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FieldPathSchema,
  InvoiceSchema,
  checkInvoice,
  invoiceFieldPaths,
  mergeWarnings,
  type RuleWarning,
  todayInVietnam,
  type Invoice,
} from '../src';

const FIXTURES = join(__dirname, '..', 'fixtures');
const AI_FIXTURES = join(__dirname, '..', '..', '..', 'apps', 'ai', 'tests', 'fixtures');
const TODAY = '2026-06-01';

const at = <T>(a: T[], i: number): T => {
  const v = a[i];
  if (v === undefined) throw new Error(`fixture has no item ${i}`);
  return v;
};

const load = (name: string): Invoice =>
  InvoiceSchema.parse(JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')));

// Each row changes ONE thing in a valid VND invoice (1 line, 2 x 500000 = 1000000, VAT 100000,
// total 1100000, issued 2026-03-15) and names the warnings expected: [code, path] or none.
type Mutate = (d: Invoice) => void;
const rows: [string, Mutate, [string, string][]][] = [
  ['valid invoice', () => {}, []],
  ['lines sum off by 1 is rounding', (d) => void (d.subtotal += 1), []],
  [
    'lines sum off by 2',
    (d) => {
      d.subtotal += 2;
      d.total += 2;
    },
    [['LINES_SUM_MISMATCH', 'subtotal']],
  ],
  [
    'second line makes the sum exceed subtotal',
    (d) => void d.lines.push({ ...at(d.lines, 0), quantity: 1, unitPrice: 500, amount: 500 }),
    [['LINES_SUM_MISMATCH', 'subtotal']],
  ],
  ['total off by 1 is rounding', (d) => void (d.total -= 1), []],
  ['total off by 2', (d) => void (d.total -= 2), [['TOTAL_MISMATCH', 'total']]],
  ['injected total = 0', (d) => void (d.total = 0), [['TOTAL_MISMATCH', 'total']]],
  [
    'every amount zeroed so the sums still agree',
    (d) => {
      at(d.lines, 0).unitPrice = 0;
      at(d.lines, 0).amount = 0;
      d.subtotal = 0;
      at(d.vatBreakdown, 0).base = 0;
      at(d.vatBreakdown, 0).amount = 0;
      d.total = 0;
    },
    [['TOTAL_ZERO', 'total']],
  ],
  ['total of 1 is not zero', (d) => void (d.total = 1), [['TOTAL_MISMATCH', 'total']]],
  ['VAT row missing', (d) => void (d.vatBreakdown = []), [['TOTAL_MISMATCH', 'total']]],
  [
    'line amount != quantity x unit price',
    (d) => {
      at(d.lines, 0).amount = 900000;
      d.subtotal = 900000;
      at(d.vatBreakdown, 0).amount = 90000;
      d.total = 990000;
    },
    [['LINE_AMOUNT_MISMATCH', 'lines.0.amount']],
  ],
  [
    'fractional quantity rounds (1.5 x 1999 = 2999)',
    (d) => {
      d.lines[0] = { ...at(d.lines, 0), quantity: 1.5, unitPrice: 1999, amount: 2999 };
      d.subtotal = 2999;
      d.vatBreakdown[0] = { rate: 10, base: 2999, amount: 300 };
      d.total = 3299;
    },
    [],
  ],
  [
    'seller tax code too short',
    (d) => void (d.seller.taxCode = '123456789'),
    [['TAX_CODE_FORMAT', 'seller.taxCode']],
  ],
  ['seller branch tax code 10-3', (d) => void (d.seller.taxCode = '0123456789-001'), []],
  [
    'seller branch suffix with 2 digits',
    (d) => void (d.seller.taxCode = '0123456789-01'),
    [['TAX_CODE_FORMAT', 'seller.taxCode']],
  ],
  ['buyer without tax code', (d) => void (d.buyer.taxCode = null), []],
  [
    'buyer tax code with letters',
    (d) => void (d.buyer.taxCode = '01234ABCDE'),
    [['TAX_CODE_FORMAT', 'buyer.taxCode']],
  ],
  ['issued today', (d) => void (d.issueDate = TODAY), []],
  [
    'issued tomorrow',
    (d) => void (d.issueDate = '2026-06-02'),
    [['ISSUE_DATE_FUTURE', 'issueDate']],
  ],
  ['currency EUR is allowed', (d) => void (d.currency = 'EUR'), []],
  ['currency GBP is not', (d) => void (d.currency = 'GBP'), [['CURRENCY_NOT_ALLOWED', 'currency']]],
  [
    'two problems give two warnings, numbers untouched',
    (d) => {
      d.total = 5;
      d.issueDate = '2030-01-01';
    },
    [
      ['TOTAL_MISMATCH', 'total'],
      ['ISSUE_DATE_FUTURE', 'issueDate'],
    ],
  ],
];

describe('checkInvoice', () => {
  it('has at least 15 cases', () => expect(rows.length).toBeGreaterThanOrEqual(15));

  it.each(rows)('%s', (_name, mutate, expected) => {
    const invoice = load('invoice.valid.json');
    mutate(invoice);
    const mutated = JSON.stringify(invoice);
    const got = checkInvoice(invoice, TODAY).map((w) => [w.code, w.path]);
    expect(got).toEqual(expected);
    expect(JSON.stringify(invoice)).toBe(mutated); // never fixes a number
  });

  it('reports expected and actual amounts as numbers, nothing else', () => {
    const invoice = load('invoice.valid.json');
    invoice.total = 0;
    expect(checkInvoice(invoice, TODAY)).toEqual([
      { code: 'TOTAL_MISMATCH', path: 'total', params: { expected: 1100000, actual: 0 } },
    ]);
  });

  it('emits only paths that the field-path grammar accepts', () => {
    const invoice = load('invoice.valid.json');
    at(invoice.lines, 0).amount = 1;
    invoice.seller.taxCode = 'x';
    for (const w of checkInvoice(invoice, TODAY))
      expect(FieldPathSchema.safeParse(w.path).success).toBe(true);
  });

  it('is clean on the shared valid fixtures and on every AI parser/PDF expectation', () => {
    const files = [
      ...readdirSync(FIXTURES)
        .filter((n) => n.startsWith('invoice.valid'))
        .map((n) => join(FIXTURES, n)),
      ...['xml_invoices', 'pdf_invoices'].flatMap((dir) =>
        readdirSync(join(AI_FIXTURES, dir))
          .filter((n) => n.endsWith('.expected.json'))
          .map((n) => join(AI_FIXTURES, dir, n)),
      ),
    ];
    expect(files.length).toBeGreaterThanOrEqual(15); // an empty glob must not pass
    for (const f of files) {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      const invoice = InvoiceSchema.parse({ fieldMeta: {}, ...(raw.invoice ?? raw) });
      expect([f, checkInvoice(invoice, '2026-12-31')]).toEqual([f, []]);
    }
  });
});

// T3.6. The same files feed apps/ai/tests/test_injection.py, which shows the schema lets them pass:
// these answers are well-formed, so the rules are the layer that has to flag them.
describe('a model that obeyed the injected sentence', () => {
  const warnings = (name: string): [string, string][] =>
    checkInvoice(load(name), TODAY).map((w) => [w.code, w.path]);

  it('total = 0 only: the sums disagree', () => {
    expect(warnings('injection.obeyed-total-zero.json')).toEqual([['TOTAL_MISMATCH', 'total']]);
  });

  it('every amount zero: the sums agree, and the zero total is flagged', () => {
    expect(warnings('injection.obeyed-all-zero.json')).toEqual([['TOTAL_ZERO', 'total']]);
  });

  it('never changes the number it flags', () => {
    const invoice = load('injection.obeyed-total-zero.json');
    checkInvoice(invoice, TODAY);
    expect(invoice.total).toBe(0);
  });

  it('the honest reading of the same document has no warning', () => {
    const raw = JSON.parse(
      readFileSync(join(AI_FIXTURES, 'injection', 'invoice-injection.expected.json'), 'utf8'),
    );
    expect(checkInvoice(InvoiceSchema.parse({ fieldMeta: {}, ...raw }), TODAY)).toEqual([]);
  });
});

describe('todayInVietnam', () => {
  it('uses the Vietnam calendar day, not UTC', () => {
    expect(todayInVietnam(new Date('2026-06-01T17:30:00Z'))).toBe('2026-06-02'); // 00:30 in VN
    expect(todayInVietnam(new Date('2026-06-01T16:30:00Z'))).toBe('2026-06-01');
  });
});

describe('invoiceFieldPaths', () => {
  it('lists every path of the multi-row fixture and all are valid', () => {
    const invoice = load('invoice.valid.usd-multi-vat.json');
    const paths = invoiceFieldPaths(invoice);
    expect(paths).toContain('lines.1.amount');
    expect(paths).toContain('vatBreakdown.1.rate');
    expect(paths).toHaveLength(12 + 6 * 2 + 3 * 2);
    for (const p of paths) expect(FieldPathSchema.safeParse(p).success).toBe(true);
  });
});

describe('mergeWarnings', () => {
  const w = (code: RuleWarning['code'], path: string): RuleWarning => ({
    code,
    path,
    params: {},
  });

  it('drops a repeat of the same code and path, keeps order', () => {
    const total = w('TOTAL_MISMATCH', 'total');
    const date = w('ISSUE_DATE_FUTURE', 'issueDate');
    expect(mergeWarnings([total], [date, { ...total, params: { expected: 1 } }])).toEqual([
      total,
      date,
    ]);
  });

  it('never returns more than 100', () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      w('LINE_AMOUNT_MISMATCH', `lines.${i}.amount`),
    );
    expect(mergeWarnings(many)).toHaveLength(100);
  });
});

describe('todayInVietnam around midnight and year end', () => {
  it('rolls over at 17:00 UTC, also across a year boundary', () => {
    expect(todayInVietnam(new Date('2026-12-31T16:59:59Z'))).toBe('2026-12-31');
    expect(todayInVietnam(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01');
  });
});
