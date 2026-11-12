import { describe, expect, it } from 'vitest';
import { firstCitedWithEvidence, MAX_CITED_FIELDS, parseCitedFields } from './cited-fields';

describe('parseCitedFields', () => {
  it('keeps form paths, once each, in order', () => {
    expect(parseCitedFields('seller.name,total,lines.3.amount,seller.name')).toEqual([
      'seller.name',
      'total',
      'lines.3.amount',
    ]);
    expect(parseCitedFields(['total', 'vatBreakdown.0.rate'])).toEqual([
      'total',
      'vatBreakdown.0.rate',
    ]);
  });

  it('drops anything that is not a path: selectors, quotes, empty parts', () => {
    expect(
      parseCitedFields('total"],[x,<b>,a..b,,.x,__proto__,lines.0.amount.x.y,' + 'a'.repeat(41)),
    ).toEqual([]);
    expect(parseCitedFields(undefined)).toEqual([]);
  });

  it('takes at most the limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => `lines.${i}.amount`).join(',');
    expect(parseCitedFields(many)).toHaveLength(MAX_CITED_FIELDS);
  });

  // Copied by hand from what the answers cite: chunk refs (apps/ai/app/services/chunking.py
  // `_header`, `_line_text`) and aggregate refs (apps/api/.../qa/application/aggregate.ts
  // `fieldPaths`). A new shape there must be added here, or the review page would drop it.
  it('keeps every path shape the Q&A sources cite', () => {
    const shapes = [
      'invoiceNo',
      'series',
      'issueDate',
      'currency',
      'subtotal',
      'total',
      'seller.name',
      'seller.taxCode',
      'seller.address',
      'buyer.name',
      'buyer.taxCode',
      'buyer.address',
      'vatBreakdown.0.rate',
      'vatBreakdown.0.base',
      'vatBreakdown.10.amount',
      'lines.0.description',
      'lines.0.quantity',
      'lines.0.unit',
      'lines.199.unitPrice',
      'lines.0.vatRate',
      'lines.0.amount',
    ];
    expect(parseCitedFields(shapes.join(','))).toEqual(shapes);
  });
});

describe('firstCitedWithEvidence', () => {
  it('picks the first cited field, in citation order, whose value has evidence', () => {
    // The shape of an invoice's `fieldMeta` entries: confidence and, when known, evidence.
    const meta: Record<string, { confidence?: number; evidence?: { page: number; text: string } }> =
      {
        total: { confidence: 0.9 },
        'seller.name': { evidence: { page: 1, text: 'SAMPLE' } },
        'lines.0.amount': { evidence: { page: 2, text: '100' } },
      };
    expect(firstCitedWithEvidence(['total', 'lines.0.amount', 'seller.name'], meta)).toBe(
      'lines.0.amount',
    );
    expect(firstCitedWithEvidence(['total', 'buyer.name'], meta)).toBeUndefined();
    expect(firstCitedWithEvidence(['__proto__', 'constructor'], meta)).toBeUndefined();
  });
});
