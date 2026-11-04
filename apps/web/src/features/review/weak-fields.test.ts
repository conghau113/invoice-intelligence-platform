import type { Invoice, RuleWarning } from 'contracts';
import { describe, expect, it } from 'vitest';
import { loadInvoiceFixture } from '../documents/detail/detail-fixtures';
import { LOW_CONFIDENCE, shiftLineMeta, weakFields } from './weak-fields';

const fixture = () => loadInvoiceFixture() as unknown as Invoice;
const full = (inv: Invoice): Invoice => {
  // Give every field a confident meta so only what a test changes is weak.
  const meta: Invoice['fieldMeta'] = {};
  const paths = [
    'seller.name',
    'seller.taxCode',
    'seller.address',
    'buyer.name',
    'buyer.taxCode',
    'buyer.address',
    'invoiceNo',
    'series',
    'issueDate',
    'currency',
    'subtotal',
    'total',
  ];
  inv.lines.forEach((_, i) =>
    ['description', 'quantity', 'unit', 'unitPrice', 'vatRate', 'amount'].forEach((f) =>
      paths.push(`lines.${i}.${f}`),
    ),
  );
  inv.vatBreakdown.forEach((_, i) =>
    ['rate', 'base', 'amount'].forEach((f) => paths.push(`vatBreakdown.${i}.${f}`)),
  );
  for (const p of paths) meta[p] = { confidence: 0.99, evidence: null };
  return { ...inv, fieldMeta: meta };
};

describe('weakFields', () => {
  it('is empty when every field is confident and nothing warns', () => {
    expect(weakFields(full(fixture()), []).size).toBe(0);
  });

  it('flags confidence below 0.8, but not 0.8 itself', () => {
    const inv = full(fixture());
    inv.fieldMeta['invoiceNo'] = { confidence: LOW_CONFIDENCE - 0.01, evidence: null };
    inv.fieldMeta['series'] = { confidence: LOW_CONFIDENCE, evidence: null };
    const weak = weakFields(inv, []);
    expect(weak.get('invoiceNo')).toEqual([{ kind: 'lowConfidence', confidence: 0.79 }]);
    expect(weak.has('series')).toBe(false);
  });

  it('treats a field without meta as weak (the AI gave no confidence)', () => {
    const inv = full(fixture());
    delete inv.fieldMeta['issueDate'];
    expect(weakFields(inv, []).get('issueDate')).toEqual([{ kind: 'noMeta' }]);
  });

  it('adds warnings on their path, next to a low-confidence reason', () => {
    const inv = full(fixture());
    inv.fieldMeta['total'] = { confidence: 0.5, evidence: null };
    const w: RuleWarning = {
      code: 'TOTAL_MISMATCH',
      path: 'total',
      params: { expected: 1, actual: 2 },
    };
    expect(weakFields(inv, [w]).get('total')).toEqual([
      { kind: 'lowConfidence', confidence: 0.5 },
      { kind: 'warning', code: 'TOTAL_MISMATCH', params: { expected: 1, actual: 2 } },
    ]);
  });

  it('lists a line added by the user (no meta) as weak', () => {
    const inv = full(fixture());
    inv.lines = [...inv.lines, { ...inv.lines[0]! }];
    const weak = weakFields(inv, []);
    expect(weak.get(`lines.${inv.lines.length - 1}.amount`)).toEqual([{ kind: 'noMeta' }]);
  });
});

describe('shiftLineMeta', () => {
  const m = (c: number) => ({ confidence: c, evidence: null });
  it('drops the removed line and moves later lines up', () => {
    const meta = {
      'lines.0.amount': m(0.1),
      'lines.1.amount': m(0.2),
      'lines.2.amount': m(0.3),
      total: m(0.9),
    };
    expect(shiftLineMeta(meta, 1)).toEqual({
      'lines.0.amount': m(0.1),
      'lines.1.amount': m(0.3),
      total: m(0.9),
    });
  });
  it('leaves lines before the removed one and other fields alone', () => {
    expect(shiftLineMeta({ 'lines.0.unit': m(0.4), 'vatBreakdown.1.rate': m(0.5) }, 3)).toEqual({
      'lines.0.unit': m(0.4),
      'vatBreakdown.1.rate': m(0.5),
    });
  });
});
