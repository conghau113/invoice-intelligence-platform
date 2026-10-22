import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import vi_ from '../../../messages/vi.json';
import { ListError, type DocumentPage } from './list-client';

const hook = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  search: 'status=failed&page=2',
}));
vi.mock('./use-document-list', () => ({ useDocumentList: () => hook.result }));
vi.mock('./query-provider', () => ({
  QueryProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(hook.search) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as never}</a>
  ),
  usePathname: () => '/documents',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

import { DocumentsScreen } from './documents-screen';

const page: DocumentPage = {
  items: [
    {
      id: '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11',
      status: 'needs_review',
      sourceType: 'xml',
      version: 1,
      createdAt: '2026-10-22T03:04:05.123Z',
    },
  ],
  meta: { page: 2, limit: 20, total: 142, totalPages: 8 },
};
const base = {
  data: undefined,
  error: null,
  isPending: false,
  isFetching: false,
  refetch: () => undefined,
};

const render = (locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : vi_}>
      <DocumentsScreen />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  hook.search = 'status=failed&page=2';
  hook.result = { ...base };
});

describe('DocumentsScreen', () => {
  it('shows a row with its translated status, and the filter from the URL', () => {
    hook.result = { ...base, data: page };
    const html = render();
    expect(html).toContain('data-testid="document-row-3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11"');
    expect(html).toContain('data-status="needs_review"');
    expect(html).toContain('Needs review');
    expect(html).toContain('3f1c9a52');
    expect(html).toMatch(/<option value="failed" selected/);
    expect(render('vi')).toContain('Cần kiểm tra');
  });

  it('shows the total in the header and "Showing 21–40 of 142" under the table', () => {
    hook.result = { ...base, data: page };
    const html = render();
    expect(html).toContain('142 documents');
    expect(html).toContain('Showing 21–40 of 142');
    expect(render('vi')).toContain('142 tài liệu');
    expect(render('vi')).toContain('Hiển thị 21–40 trên 142');
  });

  it('shows the filters in force as removable chips', () => {
    hook.search = 'status=failed&type=xml&from=2026-09-01';
    hook.result = { ...base, data: page };
    const html = render();
    expect(html).toContain('data-testid="applied-filters"');
    expect(html).toContain('Status: Failed');
    expect(html).toContain('Type: XML');
    expect(html).toContain('Remove filter Status: Failed');
    expect(html).toContain('Clear all');
    hook.search = 'page=2';
    expect(render()).not.toContain('applied-filters');
  });

  it('marks the Uploaded-at column as the sorted one, with the direction', () => {
    hook.result = { ...base, data: page };
    hook.search = 'sort=createdAt';
    expect(render()).toContain('aria-sort="ascending"');
    hook.search = '';
    expect(render()).toContain('aria-sort="descending"');
  });

  it('tells an empty tenant from an empty filter', () => {
    hook.search = 'status=failed';
    hook.result = {
      ...base,
      data: { items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } },
    };
    const html = render();
    expect(html).toContain('No documents match the filters');
    expect(html).toContain('Clear filters'); // a way out, not only a sentence
    hook.search = '';
    expect(render()).toContain('No documents yet');
  });

  it.each([
    ['session', 'Your session has expired'],
    ['forbidden', 'You are not allowed to see this list'],
    ['unreachable', 'Cannot reach the server'],
    ['error', 'The list could not be loaded'],
  ] as const)('explains a "%s" failure', (kind, title) => {
    hook.result = { ...base, error: new ListError(kind) };
    const html = render();
    expect(html).toContain(title);
    expect(html).toContain('role="alert"');
  });

  it('keeps the rows and says so when a refresh fails', () => {
    hook.result = { ...base, data: page, error: new ListError('unreachable') };
    const html = render();
    expect(html).toContain('document-row-');
    expect(html).toContain('Could not refresh the list');
  });

  it('shows skeleton rows inside the table before the first answer, keeping header and footer', () => {
    hook.result = { ...base, isPending: true, isFetching: true };
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('Uploaded at'); // the header does not wait for the data
    expect(html).toContain('data-testid="table-footer"');
    expect(html).toContain('data-testid="table-hscroll"');
  });

  it('keeps the table, scrollbar strip and footer when the list is empty or failed', () => {
    for (const result of [
      { ...base, data: { items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } } },
      { ...base, error: new ListError('unreachable') },
    ]) {
      hook.result = result;
      const html = render();
      expect(html).toContain('data-testid="table-state"');
      expect(html).toContain('Uploaded at');
      expect(html).toContain('data-testid="table-hscroll"');
      expect(html).toContain('data-testid="table-footer"');
    }
  });

  it('has a refresh button in the page header', () => {
    hook.result = { ...base, data: page };
    expect(render()).toContain('aria-label="Refresh the list"');
  });
});
