import { MAX_BACKOFF_MS, backoffMs, extractionJobSchema, parseTraceparent } from './extraction-job';

const ID = '00000000-0000-4000-8000-0000000000d1';
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const TRACE = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('extractionJobSchema', () => {
  it('accepts ids with an optional traceparent', () => {
    expect(extractionJobSchema.parse({ documentId: ID, tenantId: TENANT })).toEqual({
      documentId: ID,
      tenantId: TENANT,
    });
    expect(
      extractionJobSchema.parse({ documentId: ID, tenantId: TENANT, traceparent: TRACE }),
    ).toMatchObject({ traceparent: TRACE });
  });

  it('rejects any extra field, so content cannot ride along in a job', () => {
    const r = extractionJobSchema.safeParse({
      documentId: ID,
      tenantId: TENANT,
      xml: '<Invoice/>',
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid ids and a malformed traceparent', () => {
    expect(extractionJobSchema.safeParse({ documentId: 'x', tenantId: TENANT }).success).toBe(
      false,
    );
    expect(
      extractionJobSchema.safeParse({ documentId: ID, tenantId: TENANT, traceparent: 'nope' })
        .success,
    ).toBe(false);
  });
});

describe('parseTraceparent', () => {
  it('keeps a valid header and drops everything else', () => {
    expect(parseTraceparent(TRACE)).toBe(TRACE);
    expect(
      parseTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01'),
    ).toBeUndefined();
    expect(parseTraceparent(['a'])).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });
});

describe('backoffMs (full jitter)', () => {
  it('draws from 0 up to a ceiling that doubles with every failed attempt', () => {
    const top = (n: number) => backoffMs(n, 1000, () => 0.999999);
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 1000, () => 0))).toEqual([0, 0, 0, 0]);
    expect([top(1), top(2), top(3), top(4)]).toEqual([999, 1999, 3999, 7999]);
  });

  it('spreads over the whole range, not only its upper half', () => {
    // Equal jitter would never go below half of the ceiling (2000 ms on the third attempt).
    expect(backoffMs(3, 1000, () => 0.1)).toBe(400);
    expect(backoffMs(3, 1000, () => 0.9)).toBe(3600);
  });

  it('is capped', () => {
    expect(backoffMs(40, 1000, () => 0.999999)).toBeLessThan(MAX_BACKOFF_MS);
  });
});
