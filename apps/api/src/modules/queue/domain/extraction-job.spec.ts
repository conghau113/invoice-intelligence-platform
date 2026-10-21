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

describe('backoffMs', () => {
  it('grows exponentially: the range doubles with every failed attempt', () => {
    const low = (n: number) => backoffMs(n, 1000, () => 0);
    const high = (n: number) => backoffMs(n, 1000, () => 0.999999);
    expect([low(1), low(2), low(3), low(4)]).toEqual([500, 1000, 2000, 4000]);
    expect(high(1)).toBeLessThan(1000);
    expect(high(3)).toBeLessThan(4000);
    expect(high(3)).toBeGreaterThanOrEqual(low(3));
  });

  it('jitters: different random draws give different waits within one attempt', () => {
    expect(backoffMs(3, 1000, () => 0.1)).not.toBe(backoffMs(3, 1000, () => 0.9));
  });

  it('is capped', () => {
    expect(backoffMs(40, 1000, () => 0.999999)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});
