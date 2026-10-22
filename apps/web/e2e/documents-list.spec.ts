import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { login } from './support/login';

// Synthetic XML built in memory; the nonce keeps each run's bytes new (the API dedupes by hash).
const xml = (name: string) => ({
  name,
  mimeType: 'application/xml',
  buffer: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><HDon><!-- SAMPLE ${randomUUID()} --></HDon>`,
  ),
});

const rows = (page: Page) => page.locator('[data-testid^="document-row-"]');

async function openList(page: Page, query = '') {
  await login(page, 'accountant');
  await page.goto(`/vi/documents${query}`);
  await expect(page.getByTestId('documents-screen')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

async function upload(page: Page, count: number) {
  await page.goto('/vi/upload');
  await page.waitForLoadState('networkidle');
  const files = Array.from({ length: count }, (_, i) => xml(`doc-${i}.xml`));
  await page.getByTestId('file-input').setInputFiles(files);
  for (const f of files) {
    await expect(page.getByTestId(`upload-state-${f.name}`)).toHaveAttribute('data-state', 'done', {
      timeout: 30_000,
    });
  }
}

test.describe('document list', () => {
  test('an uploaded file shows up newest first, reached from the upload screen', async ({
    page,
  }) => {
    await login(page, 'accountant');
    await upload(page, 1);
    await page.getByTestId('view-documents').click();
    await expect(page).toHaveURL(/\/vi\/documents$/);
    await expect(rows(page).first()).toBeVisible();
    await expect(rows(page).first().locator('time')).toBeVisible();
  });

  test('a filter lives in the URL: choosing it updates the URL, and a pasted URL restores it', async ({
    page,
  }) => {
    await openList(page);
    await page.getByLabel('Loại file').selectOption('xml');
    await expect(page).toHaveURL(/type=xml/);
    await page.getByRole('button', { name: 'Sắp xếp theo Tải lên lúc' }).click();
    await expect(page).toHaveURL(/type=xml/);
    await expect(page).toHaveURL(/sort=createdAt/);

    // The "shared" link, opened in a fresh page of the same session.
    const url = page.url();
    const other = await page.context().newPage();
    await other.goto(url);
    await expect(other.getByLabel('Loại file')).toHaveValue('xml');
    await expect(other.locator('th[aria-sort="ascending"]')).toBeVisible();
    for (const status of await other.locator('[data-testid^="document-row-"]').all()) {
      await expect(status).toBeVisible();
    }
  });

  test('every row obeys the status filter; "clear" shows all again', async ({ page }) => {
    await openList(page);
    await upload(page, 1); // at least one queued/processed document exists
    await page.goto('/vi/documents?status=failed');
    await expect(page.getByTestId('documents-screen')).toBeVisible();
    await page.waitForLoadState('networkidle');
    for (const r of await rows(page).all())
      await expect(r).toHaveAttribute('data-status', 'failed');
    await page.getByRole('button', { name: 'Xóa tất cả' }).click();
    await expect(page).not.toHaveURL(/status=/);
  });

  test('changing language keeps the filters', async ({ page }) => {
    await openList(page, '?status=queued&type=xml');
    await page.getByTestId('language-switcher').selectOption('en');
    await expect(page).toHaveURL(/\/en\/documents\?(?=.*status=queued)(?=.*type=xml)/);
    await expect(page.getByLabel('File type')).toHaveValue('xml');
  });

  test('pages: total, jump to any page, rows per page, links that keep the page', async ({
    page,
  }) => {
    await login(page, 'accountant');
    await upload(page, 25);
    await page.goto('/vi/documents?pageSize=10');
    await expect(rows(page)).toHaveCount(10);
    // The header and the bar agree on the total, which is at least what we just uploaded.
    const total = Number((await page.getByTestId('list-count').innerText()).replace(/\D/g, ''));
    expect(total).toBeGreaterThanOrEqual(25);
    await expect(page.getByTestId('list-range')).toContainText(`Hiển thị 1–10 trên ${total}`);
    const ids = async () =>
      rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    const first = await ids();

    // Click a page number.
    await page.getByRole('button', { name: 'Trang 2', exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByTestId('list-range')).toContainText(`Hiển thị 11–20 trên ${total}`);
    const second = await ids();
    expect(second.filter((id) => first.includes(id))).toEqual([]);

    // Jump to a page by typing it.
    // Enter submits the box, as a keyboard user would (the Next dev badge can cover the "Đi" button).
    await page.getByLabel(/^Đi tới trang/).fill('3');
    await page.getByLabel(/^Đi tới trang/).press('Enter');
    await expect(page).toHaveURL(/page=3/);
    await expect(page.getByRole('button', { name: 'Trang 3', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // A page past the end is moved to the last one (typed into the URL by hand).
    const lastPage = Math.ceil(total / 10);
    await page.goto('/vi/documents?pageSize=10&page=9999');
    await expect(page).toHaveURL(new RegExp(`page=${lastPage}`));
    await expect(page.getByRole('button', { name: 'Trang cuối' })).toBeDisabled();

    // More rows per page goes back to page 1 and the choice is in the URL.
    await page.getByLabel('Số dòng mỗi trang').selectOption('50');
    await expect(page).toHaveURL(/pageSize=50/);
    await expect(page).not.toHaveURL(/page=\d/);
    await expect(rows(page).first()).toBeVisible();

    // Back returns to where we were.
    await page.goBack();
    await expect(page).toHaveURL(/pageSize=10/);
  });

  test('a filter shows as a chip with the matching total, and removing it widens the list', async ({
    page,
  }) => {
    await openList(page);
    const all = Number((await page.getByTestId('list-count').innerText()).replace(/\D/g, ''));
    await page.getByLabel('Loại file').selectOption('xml');
    await expect(page.getByTestId('applied-filters')).toContainText('Loại: XML');
    await expect(page).toHaveURL(/type=xml/);
    await page.getByRole('button', { name: 'Bỏ bộ lọc Loại: XML' }).click();
    await expect(page.getByTestId('applied-filters')).toHaveCount(0);
    await expect(page).not.toHaveURL(/type=/);
    await expect
      .poll(async () =>
        Number((await page.getByTestId('list-count').innerText()).replace(/\D/g, '')),
      )
      .toBeGreaterThanOrEqual(all);
  });

  test('a filter that matches nothing offers a way out', async ({ page }) => {
    await login(page, 'accountant');
    await page.route('**/api/documents?*', (route) =>
      route.fulfill({
        json: { items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } },
      }),
    );
    await page.goto('/vi/documents?status=failed');
    await expect(page.getByText('Không có tài liệu khớp bộ lọc')).toBeVisible();
    await page
      .getByTestId('documents-screen')
      .getByRole('button', { name: 'Xóa bộ lọc', exact: true })
      .click();
    await expect(page).not.toHaveURL(/status=/);
  });

  test('the list refreshes itself while a document is in flight', async ({ page }) => {
    await login(page, 'accountant');
    const id = randomUUID();
    let calls = 0;
    let settled = false; // flipped by the test once it has seen the in-flight state
    await page.route('**/api/documents?*', (route) => {
      calls += 1;
      const status = settled ? 'needs_review' : 'processing';
      return route.fulfill({
        json: {
          items: [
            { id, status, sourceType: 'xml', version: 1, createdAt: '2026-10-22T03:00:00.000Z' },
          ],
          meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      });
    });
    await page.goto('/vi/documents');
    const row = page.getByTestId(`document-row-${id}`);
    await expect(row).toHaveAttribute('data-status', 'processing');
    settled = true;
    // No reload, no click: the 5 s poll fetches again and the badge changes.
    await expect(row).toHaveAttribute('data-status', 'needs_review', { timeout: 12_000 });
    const callsWhenSettled = calls;
    await page.waitForTimeout(6_000);
    expect(calls).toBe(callsWhenSettled); // nothing in flight any more: polling stopped
  });

  test('says so when the API cannot be reached', async ({ page }) => {
    await login(page, 'accountant');
    await page.route('**/api/documents?*', (route) =>
      route.fulfill({ status: 502, json: { code: 'API_UNREACHABLE' } }),
    );
    await page.goto('/vi/documents');
    await expect(page.getByTestId('documents-screen').getByRole('alert')).toContainText(
      'Không kết nối được máy chủ',
    );
  });

  test('a viewer can open the list', async ({ page }) => {
    await login(page, 'viewer');
    await expect(page.getByTestId('nav-documents')).toBeVisible();
    await page.goto('/vi/documents');
    await expect(page.getByTestId('documents-screen')).toBeVisible();
  });
});
