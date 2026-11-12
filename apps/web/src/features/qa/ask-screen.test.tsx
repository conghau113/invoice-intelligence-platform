import type { QaAggregateResult, QaCitation } from 'contracts';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import vi_ from '../../../messages/vi.json';
import { initialAskState, type AskState } from './ask-state';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

import { AskView } from './ask-screen';

const DOC = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
const citation = (n: number): QaCitation => ({
  n,
  documentId: DOC,
  documentVersion: 2,
  invoiceId: '9b5e7f40-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
  chunkId: null,
  refs: [{ document_id: DOC, field_path: 'total', page: 1 }],
});

const render = (state: Partial<AskState>, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'en' ? en : vi_}
      timeZone="Asia/Ho_Chi_Minh"
    >
      <AskView
        state={{ ...initialAskState, question: 'Q?', ...state }}
        onAsk={() => undefined}
        onStop={() => undefined}
      />
    </NextIntlClientProvider>,
  );

const aggregate: QaAggregateResult = {
  filter: {
    metric: 'total',
    sellerName: 'Garcia',
    sellerTaxCode: null,
    issueDateFrom: '2026-09-01',
    issueDateTo: '2026-09-30',
    currency: null,
    itemDescription: null,
  },
  results: [
    { currency: 'VND', amount: 12_345_000 },
    { currency: 'USD', amount: 123_450 },
  ],
  invoiceCount: 3,
  sellers: [
    { name: 'Garcia-Riley SAMPLE', taxCode: '0100000001' },
    { name: 'Garcia Ltd SAMPLE', taxCode: '0100000002' },
  ],
  sellerCount: 2,
};

describe('AskView', () => {
  it('shows only the form before the first question', () => {
    const html = render({ phase: 'idle' });
    expect(html).toContain('data-testid="qa-question"');
    expect(html).not.toContain('data-testid="qa-result"');
  });

  it('while waiting: a status, a stop button, and the ask button disabled', () => {
    const html = render({ phase: 'waiting' }, 'vi');
    expect(html).toContain('data-testid="qa-waiting"');
    expect(html).toContain('Đang tìm trong hoá đơn');
    expect(html).toContain('data-testid="qa-stop"');
    expect(html).toMatch(/data-testid="qa-ask" disabled=""/);
  });

  it('renders the answer as text: markup from the model is escaped, markers are chips', () => {
    const html = render({
      phase: 'done',
      text: 'Ink <b>bold</b> [link](https://x.example) [1]',
      citations: [citation(1)],
    });
    expect(html).toContain('Ink &lt;b&gt;bold&lt;/b&gt; [link](https://x.example) ');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('href="https://x.example"');
    expect(html).toContain(`href="/documents/${DOC}?fields=total"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('aria-label="Open source 1"');
  });

  it('a marker is not a link until the citations arrive', () => {
    const html = render({ phase: 'streaming', text: 'Ink [1]', citations: null });
    expect(html).toContain('data-testid="citation-pending"');
    expect(html).not.toContain('data-testid="citation-chip"');
  });

  it.each([
    [
      'vi',
      ['12.345.000', '₫', '1.234,50', 'US$', '3 hoá đơn đã duyệt', 'Garcia', 'Gồm 2 người bán'],
    ],
    [
      'en',
      ['₫12,345,000', '$1,234.50', '3 approved invoices', 'Sep 1, 2026', 'Includes 2 suppliers'],
    ],
  ] as const)(
    'an aggregate in %s: money per currency from minor units, the filter, the sellers',
    (locale, parts) => {
      const html = render({ phase: 'done', aggregate, citations: [citation(1)] }, locale);
      for (const p of parts) expect(html).toContain(p);
      expect(html).toContain('data-testid="citation-chip"');
    },
  );

  it('a refusal says why in the locale', () => {
    const html = render({ phase: 'refused', refusal: 'OUT_OF_SCOPE' }, 'vi');
    expect(html).toContain('data-reason="OUT_OF_SCOPE"');
    expect(html).toContain('không nói về hoá đơn');
  });

  it('a failure with an API code uses the shared message; a cut answer is marked unfinished', () => {
    const html = render({
      phase: 'failed',
      text: 'Ink',
      failure: { kind: 'http', status: 503, code: 'AI_SERVICE_UNAVAILABLE' },
    });
    expect(html).toContain('The AI service is not responding');
    expect(html).toContain('data-testid="qa-unfinished"');
    expect(render({ phase: 'failed', failure: { kind: 'stream' } })).toContain(
      'interrupted or malformed',
    );
  });
});
