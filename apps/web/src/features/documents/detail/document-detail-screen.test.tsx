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
  invoice: null,
  reopenedFrom: null,
};
const state = { data: undefined, error: null, isPending: false, refetch: () => undefined };

const render = (locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : vi_}>
      <DocumentDetailScreen id={ID} canApprove />
    </NextIntlClientProvider>,
  );
beforeEach(() => {
  hook.result = { ...state };
});

describe('DocumentDetailScreen', () => {
  it('shows the review screen: the original beside an editable form, status in the locale', () => {
    hook.result = { ...state, data: base };
    const html = render();
    expect(html).toContain('data-testid="review-screen"');
    expect(html).toContain('data-testid="document-viewer"');
    expect(html).toContain('data-source="xml"');
    expect(html).toContain('data-testid="invoice-data"');
    expect(html).toContain('Needs review');
    expect(html).toContain('data-testid="approve-form"'); // may edit
    expect(html).toContain('No warnings');
    // Money inputs are controlled, so the server markup already carries the amount (VND: whole units).
    expect(html).toContain('value="1100000"');
    expect(render('vi')).toContain('Cần kiểm tra');
    expect(render('vi')).toContain('Không có cảnh báo');
  });

  it('a person without the approve permission sees the form read-only, with no approve button', () => {
    hook.result = { ...state, data: base };
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        <DocumentDetailScreen id={ID} canApprove={false} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('readOnly=""');
    expect(html).not.toContain('data-testid="approve-form"');
    expect(html).toContain('You can read this invoice but not change it.');
  });

  it('an approved document shows what the person approved, read-only, not the AI values', () => {
    const extraction = base.extraction!;
    hook.result = {
      ...state,
      data: {
        ...base,
        status: 'approved',
        invoice: {
          id: '7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f',
          documentVersion: 1,
          data: { ...extraction.data, total: 987654 },
          warnings: [],
          approvedAt: '2026-10-27T03:04:06.000Z',
        },
      },
    };
    const html = render();
    // Money inputs are controlled, so the server markup carries the value.
    expect(html).toContain('value="987654"');
    expect(html).not.toContain(`value="${extraction.data.total}"`);
    expect(html).not.toContain('data-testid="approve-form"');
    expect(html).toContain('This invoice is approved, so it is read-only.');
    expect(html).toContain('This invoice was approved on');
    expect(html).toContain('data-testid="reopen"');
    expect(render('vi')).toContain('Hoá đơn đã duyệt nên chỉ xem được.');
  });

  it('a person without the permission sees no Reopen button on an approved invoice', () => {
    const extraction = base.extraction!;
    hook.result = {
      ...state,
      data: {
        ...base,
        status: 'approved',
        invoice: {
          id: '7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f',
          documentVersion: 1,
          data: extraction.data,
          warnings: [],
          approvedAt: '2026-10-27T03:04:06.000Z',
        },
      },
    };
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Ho_Chi_Minh">
        <DocumentDetailScreen id={ID} canApprove={false} />
      </NextIntlClientProvider>,
    );
    expect(html).not.toContain('data-testid="reopen"');
  });

  it('a reopened invoice starts from what was approved, editable, and is not called approved', () => {
    const extraction = base.extraction!;
    hook.result = {
      ...state,
      data: {
        ...base,
        status: 'needs_review',
        version: 2,
        reopenedFrom: {
          id: '7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f',
          documentVersion: 1,
          data: { ...extraction.data, total: 987654 },
          warnings: [],
          approvedAt: '2026-10-27T03:04:06.000Z',
        },
      },
    };
    const html = render();
    expect(html).toContain('value="987654"');
    expect(html).toContain('data-testid="approve-form"');
    expect(html).not.toContain('data-testid="reopen"');
    expect(html).toContain('You are correcting the invoice approved at version 1.');
    expect(html).not.toContain('This invoice was approved on');
  });

  it('a document that is not waiting for review cannot be approved, even with the permission', () => {
    hook.result = { ...state, data: { ...base, status: 'failed', version: 2 } };
    expect(render()).not.toContain('data-testid="approve-form"');
  });

  it('a failed document that still has an older extraction shows the failure and the old values', () => {
    hook.result = {
      ...state,
      data: { ...base, version: 2, status: 'failed', failureCode: 'XML_MALFORMED' },
    };
    const html = render();
    expect(html).toContain('The file is not well-formed XML.');
    expect(html).toContain('data-testid="review-screen"');
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
