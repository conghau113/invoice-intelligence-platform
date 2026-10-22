import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import vi from '../../../messages/vi.json';
import { AppliedFilters } from './applied-filters';
import { DataTable, type Column } from './data-table';
import { ListPageHeader } from './list-page-header';
import { ListPagination } from './list-pagination';
import { DataGrid } from './data-grid';

const render = (node: ReactElement, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : vi}>
      {node}
    </NextIntlClientProvider>,
  );

const pagination = (over: Partial<Parameters<typeof ListPagination>[0]> = {}) => (
  <ListPagination
    page={10}
    pageSize={20}
    pageSizes={[10, 20, 50, 100]}
    total={1000}
    totalPages={50}
    onPageChange={() => undefined}
    onPageSizeChange={() => undefined}
    {...over}
  />
);

describe('ListPagination', () => {
  it('says which rows are shown out of how many, in both languages', () => {
    expect(render(pagination())).toContain('Showing 181–200 of 1000');
    expect(render(pagination(), 'vi')).toContain('Hiển thị 181–200 trên 1000');
  });

  it('marks the current page, shows neighbours and gaps, and names every button', () => {
    const html = render(pagination());
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(
      /aria-label="Page 10"[^>]*aria-current="page"|aria-current="page"[^>]*aria-label="Page 10"/,
    );
    for (const label of [
      'Page 1',
      'Page 9',
      'Page 11',
      'Page 50',
      'First page',
      'Previous page',
      'Next page',
      'Last page',
    ]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain('aria-label="Page 5"'); // hidden behind the gap
    expect(html).toContain('…');
    expect(html).toContain('<nav');
  });

  it('disables first/previous on page 1 and next/last on the last page', () => {
    const first = render(pagination({ page: 1 }));
    expect(first).toMatch(
      /aria-label="First page"[^>]*disabled=""|disabled=""[^>]*aria-label="First page"/,
    );
    expect(first).not.toMatch(/aria-label="Next page"[^>]*disabled=""/);
    const last = render(pagination({ page: 50 }));
    expect(last).toMatch(
      /aria-label="Last page"[^>]*disabled=""|disabled=""[^>]*aria-label="Last page"/,
    );
  });

  it('offers the page sizes with the current one selected', () => {
    const html = render(pagination({ pageSize: 50 }));
    expect(html).toContain('Rows per page');
    expect(html).toMatch(/<option value="50" selected/);
    expect(html).toContain('<option value="100"');
  });

  it('has a jump box naming the range of pages, only when there is more than one page', () => {
    expect(render(pagination())).toContain('Go to page (1–50)');
    const single = render(pagination({ page: 1, total: 5, totalPages: 1 }));
    expect(single).not.toContain('Go to page');
  });

  it('with nothing to show, there are no page buttons and the range is 0–0', () => {
    const html = render(pagination({ page: 1, total: 0, totalPages: 0 }));
    expect(html).toContain('Showing 0–0 of 0');
    expect(html).not.toContain('<nav');
  });
});

describe('AppliedFilters', () => {
  it('renders a removable chip per filter and a clear-all button', () => {
    const html = render(
      <AppliedFilters
        filters={[
          { key: 'status', label: 'Status: Failed', onRemove: () => undefined },
          { key: 'type', label: 'Type: XML', onRemove: () => undefined },
        ]}
        onClearAll={() => undefined}
      />,
    );
    expect(html).toContain('Status: Failed');
    expect(html).toContain('aria-label="Remove filter Type: XML"');
    expect(html).toContain('Clear all');
  });

  it('renders nothing without filters', () => {
    expect(render(<AppliedFilters filters={[]} onClearAll={() => undefined} />)).toBe('');
  });
});

describe('DataGrid', () => {
  type Row = { id: string };
  const columns: Column<Row>[] = [
    { key: 'id', header: 'ID', width: 100, cell: (r) => r.id, title: (r) => `full ${r.id}` },
    { key: 'when', header: 'When', width: 250, sortable: true, cell: (r) => r.id },
  ];
  const grid = (over: Partial<Parameters<typeof DataGrid<Row>>[0]> = {}) =>
    render(
      <DataGrid
        caption="Things"
        columns={columns}
        rows={[{ id: 'a' }, { id: 'b' }, { id: 'c' }]}
        rowKey={(r) => r.id}
        footer={<span>FOOT</span>}
        {...over}
      />,
    );
  const at = (html: string, needle: string) => html.indexOf(needle);

  it('stacks viewport, always-present scrollbar strip and footer, in that order', () => {
    const html = grid();
    const [viewport, strip, footer] = [
      at(html, 'data-testid="table-viewport"'),
      at(html, 'data-testid="table-hscroll"'),
      at(html, 'data-testid="table-footer"'),
    ];
    expect(viewport).toBeGreaterThan(-1);
    expect(viewport).toBeLessThan(strip);
    expect(strip).toBeLessThan(footer);
    expect(html).toMatch(
      /data-testid="table-hscroll"[^>]*aria-hidden|aria-hidden[^>]*data-testid="table-hscroll"/,
    ); // not a second tab stop
    expect(html).toContain('FOOT');
    // The strip exists whatever the data is: it is not rendered from the rows.
    expect(grid({ rows: [] })).toContain('data-testid="table-hscroll"');
  });

  it('keeps column widths and gives the table a minimum width, so it scrolls instead of squeezing', () => {
    const html = grid();
    expect(html).toContain('<col style="width:100px"/>');
    expect(html).toContain('<col style="width:250px"/>');
    expect(html).toContain('min-width:350px');
    expect(html).toContain('table-fixed');
  });

  it('has a sticky header inside the same scroll container as the rows, and offers a cell tooltip', () => {
    const html = grid();
    expect(html).toMatch(/<thead[^>]*sticky top-0/);
    expect(html).toContain('title="full a"');
    expect(html).toContain('scope="col"');
    expect(html).toContain('aria-sort="none"');
  });

  it('shows skeleton rows while loading, and the header stays', () => {
    const html = grid({ loading: true, loadingRows: 5, rows: [] });
    expect((html.match(/data-slot="skeleton"/g) ?? []).length).toBe(10);
    expect(html).toContain('>ID<');
    expect(html).toContain('FOOT');
  });

  it('shows a state instead of the rows without moving the header, strip or footer', () => {
    const html = grid({ rows: [], state: <p>Nothing here</p> });
    expect(html).toContain('Nothing here');
    expect(html).toContain('>When<');
    expect(html).toContain('data-testid="table-hscroll"');
    expect(html).toContain('FOOT');
    expect(html).not.toContain('<tbody class="[&amp;_tr:last-child]:border-0"><tr');
  });

  it('does not size itself from its rows: it fills what its parent gives', () => {
    const one = grid({ rows: [{ id: 'a' }] });
    const many = grid({ rows: Array.from({ length: 200 }, (_, i) => ({ id: String(i) })) });
    const panel = (h: string) => /data-testid="table-panel"[^>]*class="([^"]*)"/.exec(h)?.[1];
    expect(panel(one)).toBe(panel(many));
    expect(panel(one)).toContain('flex-1');
    expect(panel(one)).toContain('min-h-0');
  });
});

describe('ListPageHeader', () => {
  it('shows the count badge only when it is known and a progress bar only while refreshing', () => {
    const idle = render(
      <ListPageHeader
        title="T"
        count="142 documents"
        refreshing={false}
        refreshingLabel="Updating"
      />,
    );
    expect(idle).toContain('142 documents');
    expect(idle).not.toContain('role="progressbar"');
    const busy = render(<ListPageHeader title="T" refreshing refreshingLabel="Updating" />);
    expect(busy).toContain('role="progressbar"');
    expect(busy).not.toContain('list-count');
  });
});

describe('DataTable sorting', () => {
  type Row = { id: string };
  const columns: Column<Row>[] = [
    { key: 'id', header: 'ID', cell: (r) => r.id },
    { key: 'when', header: 'When', sortable: true, cell: (r) => r.id },
  ];
  const table = (sort?: { key: string; direction: 'asc' | 'desc' }, onSort = () => undefined) =>
    render(
      <DataTable
        caption="c"
        columns={columns}
        rows={[{ id: 'x' }]}
        rowKey={(r) => r.id}
        sort={sort}
        onSort={onSort}
        sortLabel={(c) => `Sort by ${c.header}`}
      />,
    );

  it('turns a sortable header into a button and reports its direction with aria-sort', () => {
    expect(table({ key: 'when', direction: 'asc' })).toContain('aria-sort="ascending"');
    expect(table({ key: 'when', direction: 'desc' })).toContain('aria-sort="descending"');
    expect(table({ key: 'other', direction: 'asc' })).toContain('aria-sort="none"');
    expect(table()).toContain('aria-label="Sort by When"');
  });

  it('leaves the other headers as plain text', () => {
    const html = table();
    expect(html.match(/<button/g)?.length).toBe(1);
    expect((html.match(/aria-sort/g) ?? []).length).toBe(1);
  });
});
