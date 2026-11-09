import { correctionRate, REPORTED_FIELDS } from './correction-rate';

describe('correctionRate', () => {
  it('lists every reported field in form order, at 0 when nothing was corrected', () => {
    const fields = correctionRate(4, []);
    expect(fields.map((f) => f.field)).toEqual(REPORTED_FIELDS);
    expect(fields.every((f) => f.documents === 0 && f.rate === 0)).toBe(true);
  });

  it('groups line and VAT columns, after the header fields', () => {
    expect(REPORTED_FIELDS.slice(0, 3)).toEqual([
      'seller.name',
      'seller.taxCode',
      'seller.address',
    ]);
    expect(REPORTED_FIELDS).toContain('lines.*.amount');
    expect(REPORTED_FIELDS.at(-1)).toBe('vatBreakdown.*.amount');
    expect(REPORTED_FIELDS.some((f) => /\.\d+\./.test(f))).toBe(false);
  });

  it('no approved document: rates are 0, never NaN', () => {
    expect(correctionRate(0, []).every((f) => f.rate === 0)).toBe(true);
  });

  it('divides the documents of each field by the approved documents', () => {
    const fields = correctionRate(4, [
      { field: 'invoiceNo', documents: 2 },
      { field: 'lines.*.amount', documents: 1 },
    ]);
    expect(fields.find((f) => f.field === 'invoiceNo')).toEqual({
      field: 'invoiceNo',
      documents: 2,
      rate: 0.5,
    });
    expect(fields.find((f) => f.field === 'lines.*.amount')?.rate).toBe(0.25);
  });

  it('keeps a path it does not know, after the known ones', () => {
    const fields = correctionRate(1, [{ field: 'buyer.email', documents: 1 }]);
    expect(fields).toHaveLength(REPORTED_FIELDS.length + 1);
    expect(fields.at(-1)).toEqual({ field: 'buyer.email', documents: 1, rate: 1 });
  });
});
