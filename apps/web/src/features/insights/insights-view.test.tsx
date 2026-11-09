import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import vi_ from '../../../messages/vi.json';
import { BarList } from './bar-list';
import { fieldKey } from './field-label';
import { sampleInsights } from './insights-fixtures';
import { InsightsView } from './insights-view';
import type { InsightsLoad } from './load-insights';

const render = (load: InsightsLoad, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : vi_} timeZone="UTC">
      <InsightsView load={load} />
    </NextIntlClientProvider>,
  );
/** Visible text only, so assertions read like the page. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('InsightsView', () => {
  it('shows the correction rate per field with counts, and the eval accuracy next to it', () => {
    const html = render({ kind: 'ok', data: sampleInsights() });
    const page = text(html);
    expect(page).toContain('Human correction rate per field');
    expect(page).toContain('Seller tax code 25% (2/8)');
    expect(page).toContain('Line: amount 12.5% (1/8)');
    expect(page).toContain('Total 0% (0/8)');
    // 6 of 8 approved without a change.
    expect(page).toContain('Approved without any correction 75%');
    expect(page).toContain('3 approved XML invoices are left out');
    expect(page).toContain('Model gemini-3.5-flash-lite, prompt invoice_extraction/v1');
    expect(page).toContain('Seller tax code 93%');
    expect(page).toContain('VAT breakdown 100%');
    expect(page).toContain('median 4.6 s, 95th percentile 12.5 s');
    expect(page).toContain('$0.0045');
    expect(page).toContain('Line items are compared by position');
  });

  it('draws each bar from its ratio', () => {
    const html = render({ kind: 'ok', data: sampleInsights() });
    expect(html).toMatch(/data-testid="bar-seller.taxCode"[\s\S]*?width:25%/);
    expect(html).toMatch(/data-testid="bar-lines.\*.amount"[\s\S]*?width:12.5%/);
  });

  it('in Vietnamese, with Vietnamese number formats', () => {
    const page = text(render({ kind: 'ok', data: sampleInsights() }, 'vi'));
    expect(page).toContain('Tỉ lệ người dùng sửa theo field');
    expect(page).toContain('MST người bán 25% (2/8)');
    expect(page).toContain('Dòng: thành tiền 12,5% (1/8)');
    expect(page).toContain('trung vị 4,6 s');
    expect(page).toContain('Không tính 3 hoá đơn XML đã duyệt');
  });

  it('nothing approved yet: an empty state instead of bars at 0', () => {
    const data = sampleInsights();
    data.online = {
      approvedDocuments: 0,
      uncorrectedDocuments: 0,
      excludedXmlDocuments: 0,
      fields: data.online.fields.map((f) => ({ ...f, documents: 0, rate: 0 })),
      costUsdPerDocument: null,
    };
    const html = render({ kind: 'ok', data });
    const page = text(html);
    expect(page).toContain('No approved PDF or image invoice yet');
    expect(html).not.toContain('data-testid="bar-total"');
    expect(page).toContain('Approved without any correction –');
    expect(page).toContain('Cost per document (this organization) No data');
  });

  it('no eval report: says so, and the online numbers still show', () => {
    const page = text(render({ kind: 'ok', data: { ...sampleInsights(), offline: null } }));
    expect(page).toContain('No evaluation report is available');
    expect(page).toContain('Seller tax code 25% (2/8)');
    expect(page).toContain('Cost per document (test set) No data');
  });

  it.each([
    ['session', 'Your session has expired'],
    ['forbidden', 'You cannot see these numbers'],
    ['unreachable', 'Cannot reach the server'],
    ['error', 'The numbers could not be loaded'],
  ] as const)('load error %s -> an alert, no numbers', (error, title) => {
    const html = render({ kind: 'error', error });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(title);
    expect(html).not.toContain('insights-online');
  });
});

describe('fieldKey', () => {
  it.each([
    ['seller.taxCode', 'sellerTaxCode'],
    ['lines.*.unitPrice', 'linesUnitPrice'],
    ['vatBreakdown.*.base', 'vatBreakdownBase'],
    ['vatBreakdown', 'vatBreakdown'],
    ['invoiceNo', 'invoiceNo'],
  ])('%s -> %s', (path, key) => expect(fieldKey(path)).toBe(key));

  it('every field the API reports has a label in both languages', async () => {
    const { HEADER_FIELD_PATHS, LINE_COLUMNS, VAT_COLUMNS } = await import('contracts');
    const paths = [
      ...HEADER_FIELD_PATHS,
      ...LINE_COLUMNS.map((c) => `lines.*.${c}`),
      ...VAT_COLUMNS.map((c) => `vatBreakdown.*.${c}`),
      'vatBreakdown',
    ];
    for (const messages of [en, vi_]) {
      const labels = messages.Insights.field as Record<string, string>;
      expect(paths.filter((p) => labels[fieldKey(p)] === undefined)).toEqual([]);
    }
  });
});

describe('BarList', () => {
  it('clamps the width to 0..100% and hides the bar from screen readers', () => {
    const html = renderToStaticMarkup(
      <BarList
        label="x"
        bars={[
          { key: 'a', label: 'A', ratio: 1.7, value: '170%' },
          { key: 'b', label: 'B', ratio: -1, value: '-' },
        ]}
      />,
    );
    expect(html).toContain('width:100%');
    expect(html).toContain('width:0%');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('aria-label="x"');
  });
});
