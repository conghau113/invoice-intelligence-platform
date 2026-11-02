import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../messages/en.json';
import vi_ from '../../../../messages/vi.json';
import { DetailError, type DocumentDetail } from './detail-client';
import { loadInvoiceFixture } from './detail-fixtures';

const hook = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock('./use-document-detail', () => ({ useDocumentDetail: () => hook.result }));
vi.mock('../query-provider', () => ({
  QueryProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { DocumentDetailScreen, FAILURE_CODES } from './document-detail-screen';

const ID = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const base: DocumentDetail = {
  id: ID,
  status: 'needs_review',
  sourceType: 'xml',
  version: 1,
  createdAt: '2026-10-26T03:04:05.123Z',
  failureCode: null,
  extraction: {
    id: '9b5e7f40-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    documentVersion: 1,
    source: 'xml',
    data: loadInvoiceFixture() as NonNullable<DocumentDetail['extraction']>['data'],
    warnings: [],
    createdAt: '2026-10-26T03:04:06.000Z',
  },
};
const state = { data: undefined, error: null, isPending: false, refetch: () => undefined };

const render = (locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : vi_}>
      <DocumentDetailScreen id={ID} />
    </NextIntlClientProvider>,
  );
beforeEach(() => {
  hook.result = { ...state };
});

describe('DocumentDetailScreen', () => {
  it('shows the extracted invoice read-only: parties, lines and the total formatted for the locale', () => {
    hook.result = { ...state, data: base };
    const html = render();
    expect(html).toContain('data-testid="invoice-data"');
    expect(html).toContain('0000123');
    expect(html).toContain('Công ty SAMPLE Bán');
    expect(html).toContain('Dịch vụ SAMPLE');
    expect(html).toContain('Needs review');
    expect(html).not.toMatch(/<input|<textarea|contenteditable/); // review form is M3 (T3.4)
    expect(html).toContain('₫1,100,000');
    expect(render('vi')).toMatch(/1\.100\.000\s?₫/);
    expect(render('vi')).toContain('Cần kiểm tra');
  });

  it('shows a dash when the buyer has no tax code', () => {
    const noCode = structuredClone(base);
    (noCode.extraction as { data: { buyer: { taxCode: string | null } } }).data.buyer.taxCode =
      null;
    hook.result = { ...state, data: noCode };
    expect(render()).toMatch(/Tax code<\/dt><dd[^>]*>—</);
  });

  it('shows "waiting" while the document is queued or processing, not an empty invoice', () => {
    hook.result = { ...state, data: { ...base, status: 'queued', extraction: null } };
    expect(render()).toContain('Waiting in the queue');
    hook.result = { ...state, data: { ...base, status: 'processing', extraction: null } };
    const html = render();
    expect(html).toContain('Extracting the invoice data');
    expect(html).not.toContain('invoice-data');
    expect(render('vi')).toContain('Đang trích xuất dữ liệu hóa đơn');
  });

  it('explains a failed document in words and shows the code', () => {
    hook.result = {
      ...state,
      data: { ...base, status: 'failed', extraction: null, failureCode: 'XML_MALFORMED' },
    };
    const html = render();
    expect(html).toContain('Extraction failed');
    expect(html).toContain('The file is not well-formed XML.');
    expect(html).toContain('data-testid="failure-code"');
    expect(render('vi')).toContain('Tệp không phải XML hợp lệ.');
  });

  it('falls back to a generic sentence for a code it has no message for, and for none at all', () => {
    hook.result = {
      ...state,
      data: { ...base, status: 'failed', extraction: null, failureCode: 'SOMETHING_NEW' },
    };
    expect(render()).toContain('The document could not be processed.');
    hook.result = { ...state, data: { ...base, status: 'failed', extraction: null } };
    expect(render()).toContain('The document could not be processed.');
  });

  it('every failure code the screen lists has a message in both languages', () => {
    for (const messages of [en, vi_]) {
      for (const code of FAILURE_CODES) {
        const failure = messages.DocumentDetail.failure as Record<string, string>;
        expect(failure[code], code).toBeTruthy();
      }
    }
  });

  it('a needs_review document with no extraction says so instead of showing nothing', () => {
    hook.result = { ...state, data: { ...base, extraction: null } };
    expect(render()).toContain('No extracted data for this document');
  });

  it.each(['session', 'forbidden', 'notFound', 'unreachable', 'error'] as const)(
    'explains a %s load error in both languages',
    (kind) => {
      hook.result = { ...state, error: new DetailError(kind) };
      expect(render()).toContain(en.DocumentDetail.errors[kind].title);
      expect(render('vi')).toContain(vi_.DocumentDetail.errors[kind].title);
    },
  );

  it('shows a loading state while the first answer is pending', () => {
    hook.result = { ...state, isPending: true };
    expect(render()).toContain('aria-busy="true"');
  });
});
