import {
  QaAnswerSchema,
  QaAskBodySchema,
  QaRouteSchema,
  aggregateFilterProblems,
  type QaAggregateFilter,
} from '../src';

const filter = (over: Partial<QaAggregateFilter> = {}): QaAggregateFilter => ({
  metric: 'total',
  sellerName: null,
  sellerTaxCode: null,
  issueDateFrom: null,
  issueDateTo: null,
  currency: null,
  itemDescription: null,
  ...over,
});

describe('QaRouteSchema (model output of the routing step)', () => {
  it('accepts a lookup and an aggregate', () => {
    expect(QaRouteSchema.safeParse({ intent: 'lookup', filter: null }).success).toBe(true);
    expect(QaRouteSchema.safeParse({ intent: 'aggregate', filter: filter() }).success).toBe(true);
  });

  it.each([
    ['a key that is not in the schema', { intent: 'aggregate', filter: { ...filter(), sql: 'x' } }],
    ['an absent key instead of null', { intent: 'lookup' }],
    ['an unknown metric', { intent: 'aggregate', filter: filter({ metric: 'max' as never }) }],
    ['an impossible date', { intent: 'aggregate', filter: filter({ issueDateTo: '2026-02-30' }) }],
    ['a bad tax code', { intent: 'aggregate', filter: filter({ sellerTaxCode: '123' }) }],
    [
      'a sentence as a seller',
      { intent: 'aggregate', filter: filter({ sellerName: 'x'.repeat(201) }) },
    ],
  ])('refuses %s', (_name, value) => {
    expect(QaRouteSchema.safeParse(value).success).toBe(false);
  });
});

describe('QaAskBodySchema', () => {
  it('accepts a question and refuses NUL, empty and too long', () => {
    expect(QaAskBodySchema.safeParse({ question: ' Ai bán SAMPLE? ' }).success).toBe(true);
    for (const question of ['a\u0000b', '   ', 'x'.repeat(1001)]) {
      expect(QaAskBodySchema.safeParse({ question }).success).toBe(false);
    }
  });
});

describe('QaAnswerSchema', () => {
  it('bounds the answer', () => {
    expect(
      QaAnswerSchema.safeParse({ insufficientEvidence: false, answer: 'x'.repeat(4001) }).success,
    ).toBe(false);
  });
});

describe('aggregateFilterProblems (rules the schema cannot express)', () => {
  it('accepts a filter that can run', () => {
    expect(
      aggregateFilterProblems(filter({ issueDateFrom: '2026-09-01', issueDateTo: '2026-09-30' })),
    ).toEqual([]);
    expect(
      aggregateFilterProblems(filter({ metric: 'lineAmount', itemDescription: 'cà phê' })),
    ).toEqual([]);
    expect(
      aggregateFilterProblems(filter({ metric: 'invoiceCount', itemDescription: 'cà phê' })),
    ).toEqual([]);
  });

  it.each([
    [
      'dates the wrong way round',
      filter({ issueDateFrom: '2026-10-01', issueDateTo: '2026-09-30' }),
    ],
    ['an item sum without an item', filter({ metric: 'lineAmount' })],
    [
      'an invoice total restricted to an item',
      filter({ metric: 'total', itemDescription: 'cà phê' }),
    ],
    ['year 0, which Postgres does not have', filter({ issueDateFrom: '0000-01-01' })],
    ['a NUL in a supplier name', filter({ sellerName: 'SAMPLE\u0000' })],
    ['a NUL in an item', filter({ metric: 'lineAmount', itemDescription: 'x\u0000' })],
  ])('refuses %s', (_name, value) => {
    expect(aggregateFilterProblems(value)).toHaveLength(1);
  });
});
