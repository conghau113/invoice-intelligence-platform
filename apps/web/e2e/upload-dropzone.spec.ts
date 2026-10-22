import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { login } from './support/login';

// Synthetic files built in memory (no temp files). A random nonce keeps every run's bytes new:
// the API dedupes by content hash per tenant, so fixed bytes would be "duplicate" on a re-run.
const xml = (name: string) => ({
  name,
  mimeType: 'application/xml',
  buffer: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><HDon><!-- SAMPLE ${randomUUID()} --></HDon>`,
  ),
});
const pdf = (name: string, size: number) => {
  const buffer = Buffer.alloc(size);
  buffer.write(`%PDF-1.4 SAMPLE ${randomUUID()}\n`);
  return { name, mimeType: 'application/pdf', buffer };
};

const row = (page: Page, name: string) => page.getByTestId(`upload-state-${name}`);

async function openUpload(page: Page) {
  await login(page, 'accountant');
  await expect(page.getByTestId('nav-upload')).toBeVisible();
  await page.goto('/vi/upload');
  await expect(page).toHaveURL(/\/vi\/upload$/);
  await page.waitForLoadState('networkidle');
}

test.describe('upload screen', () => {
  test('5 files: the one the server refuses does not block the other four', async ({ page }) => {
    await openUpload(page);
    const good = ['a.xml', 'b.xml', 'c.xml', 'd.xml'].map(xml);
    // Passes the client check (name and type say XML) but the bytes are not XML: the API sniffs 415.
    const fake = { name: 'fake.xml', mimeType: 'application/xml', buffer: Buffer.from('not xml') };
    await page
      .getByTestId('file-input')
      .setInputFiles([...good.slice(0, 2), fake, ...good.slice(2)]);

    for (const f of good) {
      await expect(row(page, f.name)).toHaveAttribute('data-state', 'done');
      await expect(
        page.getByTestId(`upload-row-${f.name}`).locator('[data-status="queued"]'),
      ).toBeVisible();
    }
    await expect(row(page, 'fake.xml')).toHaveAttribute('data-state', 'error');
    await expect(row(page, 'fake.xml')).toContainText('Loại file không được hỗ trợ');
    // Refused for good: no retry button.
    await expect(page.getByRole('button', { name: 'Thử lại fake.xml' })).toHaveCount(0);
  });

  test('a file of exactly 10 MiB goes through the web proxy intact', async ({ page }) => {
    await openUpload(page);
    await page.getByTestId('file-input').setInputFiles(pdf('big.pdf', 10 * 1024 * 1024));
    await expect(row(page, 'big.pdf')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  });

  test('the same bytes again are shown as already existing, not as an error', async ({ page }) => {
    await openUpload(page);
    const original = xml('first.xml');
    await page.getByTestId('file-input').setInputFiles(original);
    await expect(row(page, 'first.xml')).toHaveAttribute('data-state', 'done');
    await page.getByTestId('file-input').setInputFiles({ ...original, name: 'copy.xml' });
    await expect(row(page, 'copy.xml')).toHaveAttribute('data-state', 'duplicate');
    await expect(row(page, 'copy.xml')).toContainText('Đã có sẵn');
  });

  test('wrong type and over 10 MB are refused in the browser, without any request', async ({
    page,
  }) => {
    await openUpload(page);
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/documents/upload')) sent.push(r.url());
    });
    await page
      .getByTestId('file-input')
      .setInputFiles([
        { name: 'run.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
        pdf('huge.pdf', 10 * 1024 * 1024 + 1),
      ]);
    await expect(row(page, 'run.exe')).toContainText('Loại file không được hỗ trợ');
    await expect(row(page, 'huge.pdf')).toContainText('File lớn hơn 10 MB');
    expect(sent).toEqual([]);
  });

  test('a dropped connection can be retried and then succeeds', async ({ page }) => {
    await openUpload(page);
    await page.route('**/api/documents/upload', (route) => route.abort('failed'));
    await page.getByTestId('file-input').setInputFiles(xml('flaky.xml'));
    await expect(row(page, 'flaky.xml')).toContainText('Mất kết nối tới máy chủ');
    await page.unroute('**/api/documents/upload');
    await page.getByRole('button', { name: 'Thử lại flaky.xml' }).click();
    await expect(row(page, 'flaky.xml')).toHaveAttribute('data-state', 'done');
  });

  test('an upload can be cancelled while the server is still answering', async ({ page }) => {
    await openUpload(page);
    // Hold the response so the file stays "uploading" long enough to click Cancel.
    await page.route('**/api/documents/upload', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.abort('failed').catch(() => undefined);
    });
    await page.getByTestId('file-input').setInputFiles(xml('slow.xml'));
    await expect(row(page, 'slow.xml')).toHaveAttribute('data-state', 'uploading');
    await page.getByRole('button', { name: 'Hủy tải lên slow.xml' }).click();
    await expect(row(page, 'slow.xml')).toHaveAttribute('data-state', 'cancelled');
    await expect(page.getByRole('button', { name: 'Thử lại slow.xml' })).toBeVisible();
  });

  test('English UI shows English messages', async ({ page }) => {
    await login(page, 'accountant', 'en');
    await page.goto('/en/upload');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('file-input').setInputFiles({
      name: 'run.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ'),
    });
    await expect(row(page, 'run.exe')).toContainText('Unsupported file type');
  });

  test('a viewer has no upload menu and a typed URL is a translated 404', async ({ page }) => {
    await login(page, 'viewer');
    await expect(page.getByTestId('nav-upload')).toHaveCount(0);
    await page.goto('/vi/upload');
    await expect(page.getByText('Không tìm thấy trang')).toBeVisible();
  });
});
