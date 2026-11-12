import type { QaCitation } from 'contracts';
import { describe, expect, it } from 'vitest';
import { MAX_CITED_FIELDS, parseCitedFields } from '@/features/review/cited-fields';
import { answerSegments, citationHref } from './answer-segments';

const DOC = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const cite = (n: number, paths: string[] = ['seller.name']): QaCitation => ({
  n,
  documentId: DOC,
  documentVersion: 1,
  invoiceId: '9b5e7f40-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
  chunkId: null,
  refs: paths.map((p) => ({ document_id: DOC, field_path: p, page: null })),
});

describe('answerSegments', () => {
  it('turns each [n] into a marker with its source, and keeps the rest as text', () => {
    const c1 = cite(1);
    expect(answerSegments('Ink [1], paper [2].', [c1])).toEqual([
      { kind: 'text', start: 0, text: 'Ink ' },
      { kind: 'cite', start: 4, n: 1, citation: c1 },
      { kind: 'text', start: 7, text: ', paper ' },
      { kind: 'cite', start: 15, n: 2, citation: null },
      { kind: 'text', start: 18, text: '.' },
    ]);
  });

  it('has no source for any marker until the citations arrive', () => {
    expect(answerSegments('A [1]', null)).toEqual([
      { kind: 'text', start: 0, text: 'A ' },
      { kind: 'cite', start: 2, n: 1, citation: null },
    ]);
  });

  it('leaves markdown, HTML and links as plain text, and lists or spaced markers as text', () => {
    const text = '**x** <img src=x onerror=alert(1)> [link](https://evil.example) [1, 2] [ 1 ]';
    expect(answerSegments(text, [cite(1)])).toEqual([{ kind: 'text', start: 0, text }]);
  });
});

describe('citationHref', () => {
  it('opens the document with its cited fields, once each, encoded', () => {
    expect(citationHref(cite(1, ['seller.name', 'total', 'seller.name']))).toBe(
      `/documents/${DOC}?fields=seller.name%2Ctotal`,
    );
  });

  it('opens the document alone when nothing is cited, and caps a long list', () => {
    expect(citationHref(cite(1, []))).toBe(`/documents/${DOC}`);
    const many = Array.from({ length: 100 }, (_, i) => `lines.${i}.amount`);
    const fields = decodeURIComponent(citationHref(cite(1, many)).split('fields=')[1] ?? '');
    expect(fields.split(',')).toHaveLength(MAX_CITED_FIELDS);
  });

  it('the review page reads back exactly the fields a link carries', () => {
    const paths = ['seller.name', 'buyer.taxCode', 'vatBreakdown.1.base', 'lines.12.unitPrice'];
    const href = citationHref(cite(1, paths));
    const query = new URL(href, 'http://x').searchParams.get('fields') ?? undefined;
    expect(parseCitedFields(query)).toEqual(paths);
  });
});
