import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BuyerSchema,
  FieldPathSchema,
  InvoiceLineSchema,
  InvoiceSchema,
  PartySchema,
  VatBreakdownSchema,
} from '../src';

const FIXTURES = join(__dirname, '..', 'fixtures');
// Tests poke at arbitrary nested keys of untrusted-shaped JSON, which `unknown` makes unreadable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const names = (prefix: string): string[] =>
  readdirSync(FIXTURES).filter((n) => n.startsWith(prefix) && n.endsWith('.json'));

describe('InvoiceSchema (shared fixtures; Python globs the same files)', () => {
  it.each(names('invoice.valid'))('accepts %s', (name) => {
    expect(InvoiceSchema.safeParse(load(name)).success).toBe(true);
  });

  it.each(names('invoice.invalid'))('rejects %s', (name) => {
    expect(InvoiceSchema.safeParse(load(name)).success).toBe(false);
  });

  it('has at least 5 fixtures, so an empty glob cannot pass silently', () => {
    expect(names('invoice.valid').length + names('invoice.invalid').length).toBeGreaterThanOrEqual(
      5,
    );
  });
});

// Each row changes ONE thing in the valid fixture and must fail at the given path.
// apps/ai/tests/test_contract.py has the same table.
const mutations: [string, (d: Doc) => void, string[]][] = [
  ['fractional money', (d) => (d.total = 10.5), ['total']],
  ['numeric-string money', (d) => (d.total = '1100000'), ['total']],
  ['date as datetime', (d) => (d.issueDate = '2026-03-15T00:00:00'), ['issueDate']],
  ['date that does not exist', (d) => (d.issueDate = '2026-02-30'), ['issueDate']],
  ['date as epoch integer', (d) => (d.issueDate = 1773532800), ['issueDate']],
  ['date in Arabic-Indic digits', (d) => (d.issueDate = '٢٠٢٦-٠٣-١٥'), ['issueDate']],
  [
    'tax code in Arabic-Indic digits',
    (d) => (d.seller.taxCode = '٠١٢٣٤٥٦٧٨٩'),
    ['seller', 'taxCode'],
  ],
  [
    'buyer tax code absent (must be null, not missing)',
    (d) => delete d.buyer.taxCode,
    ['buyer', 'taxCode'],
  ],
  ['confidence above 1', (d) => (d.fieldMeta.total.confidence = 1.5), ['fieldMeta', 'total']],
  ['confidence below 0', (d) => (d.fieldMeta.total.confidence = -0.1), ['fieldMeta', 'total']],
  [
    'evidence absent (must be null, not missing)',
    (d) => delete d.fieldMeta.total.evidence,
    ['fieldMeta', 'total'],
  ],
  ['evidence page 0', (d) => (d.fieldMeta.total.evidence.page = 0), ['fieldMeta', 'total']],
  [
    'evidence text too long',
    (d) => (d.fieldMeta.total.evidence.text = 'x'.repeat(501)),
    ['fieldMeta', 'total'],
  ],
  [
    'fieldMeta key not a field',
    (d) => (d.fieldMeta['seller.foo'] = { confidence: 1, evidence: null }),
    ['fieldMeta'],
  ],
  ['fieldMeta missing', (d) => delete d.fieldMeta, ['fieldMeta']],
  ['no line items', (d) => (d.lines = []), ['lines']],
];

describe('InvoiceSchema mutations', () => {
  it.each(mutations)('rejects %s', (_label, mutate, path) => {
    const doc = load('invoice.valid.json');
    mutate(doc);
    const result = InvoiceSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      const hit = result.error.issues.some((i) => path.every((seg, n) => i.path[n] === seg));
      expect(hit).toBe(true);
    }
  });

  it('rejects an unknown key, naming it', () => {
    const result = InvoiceSchema.safeParse({ ...load('invoice.valid.json'), surprise: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: 'unrecognized_keys', keys: ['surprise'] }),
      ]);
    }
  });

  it('accepts a null buyer tax code and null evidence', () => {
    const doc = load('invoice.valid.json') as Doc;
    doc.buyer.taxCode = null;
    doc.fieldMeta.total.evidence = null;
    expect(InvoiceSchema.safeParse(doc).success).toBe(true);
  });
});

// Collects the field path of every leaf value (not fieldMeta itself): the grammar in
// FIELD_PATH_PATTERN must cover every field an Invoice can have, or new fields go unnoticed.
function leafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, `${prefix}${i}.`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, `${prefix}${k}.`));
  }
  return [prefix.slice(0, -1)];
}

describe('FieldPathSchema', () => {
  it.each(names('invoice.valid'))('covers every field of %s', (name) => {
    const fields = load(name);
    delete fields.fieldMeta;
    const paths = leafPaths(fields);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths)
      expect({ p, ok: FieldPathSchema.safeParse(p).success }).toEqual({ p, ok: true });
  });

  // The other direction: every key a nested schema declares must be addressable. Adding a field
  // to InvoiceSchema without extending FIELD_PATH_PATTERN turns this red.
  it('covers every key declared in the schema shapes', () => {
    const { fieldMeta, lines, vatBreakdown, seller, buyer, ...top } = InvoiceSchema.shape;
    void [fieldMeta, lines, vatBreakdown, seller, buyer];
    const paths = [
      ...Object.keys(top),
      ...Object.keys(PartySchema.shape).map((k) => `seller.${k}`),
      ...Object.keys(BuyerSchema.shape).map((k) => `buyer.${k}`),
      ...Object.keys(InvoiceLineSchema.shape).map((k) => `lines.12.${k}`),
      ...Object.keys(VatBreakdownSchema.shape).map((k) => `vatBreakdown.0.${k}`),
    ];
    expect(paths.length).toBe(6 + 3 + 3 + 6 + 3);
    for (const p of paths)
      expect({ p, ok: FieldPathSchema.safeParse(p).success }).toEqual({ p, ok: true });
  });

  it.each([
    'seller.foo',
    'lines.x.amount',
    'lines.0',
    'fieldMeta',
    'total ',
    'total\n',
    'a.total',
    'lines.007.amount',
    'lines.-1.amount',
    'vatBreakdown.01.rate',
  ])('rejects %s', (p) => {
    expect(FieldPathSchema.safeParse(p).success).toBe(false);
  });
});
