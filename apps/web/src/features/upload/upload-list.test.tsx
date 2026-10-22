import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../../../messages/en.json';
import vi from '../../../messages/vi.json';
import type { UploadItem } from './upload-queue';
import { UploadList } from './upload-list';

const item = (over: Partial<UploadItem>): UploadItem => ({
  id: 'i1',
  file: new File(['x'], 'a.xml'),
  idempotencyKey: 'k',
  state: 'pending',
  progress: 0,
  retryable: false,
  ...over,
});

const render = (items: UploadItem[], locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : vi}>
      <UploadList items={items} onCancel={() => undefined} onRetry={() => undefined} />
    </NextIntlClientProvider>,
  );

describe('UploadList', () => {
  it('shows a progressbar with the current value and a cancel button while uploading', () => {
    const html = render([item({ state: 'uploading', progress: 42 })]);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('width:42%');
    expect(html).toContain('Cancel upload of a.xml');
    expect(html).not.toContain('Retry');
  });

  it('shows the translated error with a retry button only when retrying can help', () => {
    const retryable = render([item({ state: 'error', errorKey: 'network', retryable: true })]);
    expect(retryable).toContain('role="alert"');
    expect(retryable).toContain('Lost connection to the server');
    expect(retryable).toContain('Retry a.xml');
    const refused = render([item({ state: 'error', errorKey: 'unsupportedType' })], 'vi');
    expect(refused).toContain('Loại file không được hỗ trợ');
    expect(refused).not.toContain('Thử lại');
  });

  it('shows the document status badge for done and duplicate rows', () => {
    const done = render([item({ state: 'done', document: { id: 'd', status: 'queued' } })], 'vi');
    expect(done).toContain('data-status="queued"');
    expect(done).toContain('Trong hàng đợi');
    const dup = render([item({ state: 'duplicate', document: { id: 'd', status: 'queued' } })]);
    expect(dup).toContain('Already exists');
  });
});
