import { expect, test, type Page } from '@playwright/test';
import { invoicePdf, invoiceXml, uploadFile } from './support/documents';
import { login } from './support/login';

/**
 * T3.4: the review screen against the real stack. Like upload.spec.ts it needs the worker and the
 * AI service (`LLM_PROVIDER=fake`, so the PDF answers with the canned invoice in
 * apps/ai/app/providers/fake.py: only `invoiceNo` (0.6) and `total` (0.95) carry a confidence).
 */

async function uploadAndWait(
  page: Page,
  file: ReturnType<typeof invoicePdf | typeof invoiceXml>,
): Promise<string> {
  await page.goto('/vi/upload');
  await page.waitForLoadState('networkidle');
  const { id } = await uploadFile(page, file);
  await page.goto('/vi/documents');
  await expect(
    page.getByTestId(`document-row-${id}`),
    'not needs_review: are the worker and the AI service (LLM_PROVIDER=fake pnpm dev:ai) running?',
  ).toHaveAttribute('data-status', 'needs_review', { timeout: 45_000 });
  return id;
}

async function openPdfReview(page: Page): Promise<string> {
  await login(page, 'accountant');
  const id = await uploadAndWait(page, invoicePdf('review.pdf'));
  await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
  await expect(page.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });
  return id;
}

test.describe('review screen', () => {
  test('weak fields are yellow with the reason on hover; a confident field is not', async ({
    page,
  }) => {
    await openPdfReview(page);

    // invoiceNo: confidence 0.6 -> low confidence. series: no meta at all -> unknown, also weak.
    const invoiceNo = page.locator('[data-weak][data-path="invoiceNo"]');
    await expect(invoiceNo).toBeVisible();
    await invoiceNo.hover();
    await expect(page.getByRole('tooltip').first()).toContainText('AI chỉ chắc 60%');
    await expect(page.locator('[data-weak][data-path="series"]')).toBeVisible();

    // total: confidence 0.95 and the numbers add up -> nothing to flag.
    await expect(page.locator('[data-weak][data-path="total"]')).toHaveCount(0);
    await expect(page.getByTestId('warnings')).toContainText('Không có cảnh báo');
  });

  test('editing a line recomputes the warnings, and fixing it clears them; numbers are never rewritten', async ({
    page,
  }) => {
    await openPdfReview(page);
    const amount = page.getByTestId('field-lines.0.amount');
    await expect(amount).toHaveValue('1000000');

    await amount.fill('1200000');
    const warnings = page.getByTestId('warnings');
    await expect(warnings.locator('li[data-code="LINE_AMOUNT_MISMATCH"]')).toBeVisible();
    await expect(warnings.locator('li[data-code="LINES_SUM_MISMATCH"]')).toBeVisible();
    await expect(page.locator('[data-weak][data-path="lines.0.amount"]')).toBeVisible();
    // The sum of the lines is shown next to the subtotal, but the subtotal itself is untouched.
    await expect(
      page.locator('p', { hasText: /^Các dòng cộng lại là .*1\.200\.000/ }),
    ).toBeVisible();
    await expect(page.getByTestId('field-subtotal')).toHaveValue('1000000');

    await amount.fill('1000000');
    await expect(warnings).toContainText('Không có cảnh báo');
  });

  test('adding and removing a line keeps the warnings on the right lines', async ({ page }) => {
    await openPdfReview(page);
    await page.getByTestId('add-line').click();
    await expect(page.getByTestId('line-1')).toBeVisible();
    // A new line has no confidence from the AI, so it is flagged; its empty text fails the schema.
    await expect(page.locator('[data-weak][data-path="lines.1.amount"]')).toBeVisible();
    // ...and the reason is visible text under the line, not only a tooltip.
    await expect(page.getByTestId('line-notes-1')).toContainText(
      'AI không cho biết độ tin cậy của',
    );
    await page.getByRole('button', { name: 'Xoá dòng 2' }).click();
    await expect(page.getByTestId('line-1')).toHaveCount(0);
  });

  test('the form cannot be approved while it has schema errors: nothing is sent', async ({
    page,
  }) => {
    await openPdfReview(page);
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/') && r.method() !== 'GET')
        writes.push(`${r.method()} ${r.url()}`);
    });

    await page.getByTestId('field-seller.taxCode').fill('123');
    await expect(page.getByTestId('form-errors')).toBeVisible();
    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('field-seller.taxCode')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('approved-now')).toHaveCount(0);

    expect(writes, 'a form with schema errors must not reach the API').toEqual([]);
  });

  test('clicking a field jumps the viewer to its evidence and highlights it; zoom works', async ({
    page,
  }) => {
    await login(page, 'accountant');
    const id = await uploadAndWait(page, invoicePdf('evidence.pdf'));
    // The canned evidence text is not in the sample PDF, so point it at text that is.
    await page.route(`**/api/documents/${id}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.extraction.data.fieldMeta.total.evidence = {
        page: 1,
        text: 'Tong thanh toan: 687,000 VND',
      };
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    const pdf = page.getByTestId('pdf-page');
    await expect(pdf.locator('.textLayer span').first()).toBeAttached({ timeout: 30_000 });
    await expect(pdf).toHaveAttribute('data-hits', '0');

    await page.getByTestId('field-total').focus();
    await expect(page.getByTestId('evidence-caption')).toContainText(
      'Tong thanh toan: 687,000 VND',
    );
    await expect(pdf).not.toHaveAttribute('data-hits', '0');
    await expect(pdf).toHaveAttribute('data-page', '1');
    await expect(pdf.locator('.textLayer span.rounded-sm').first()).toBeAttached();

    // A field without evidence clears the caption instead of keeping a stale one.
    await page.getByTestId('field-invoiceNo').focus();
    await expect(page.getByTestId('evidence-caption')).toContainText('Bấm vào một ô');

    const canvas = pdf.locator('canvas');
    const before = (await canvas.boundingBox())!.width;
    await page.getByRole('button', { name: 'Phóng to' }).click();
    await expect(page.getByTestId('zoom-level')).toHaveText('125%');
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(before);
  });

  test('the original file is served only through the permission check', async ({ page }) => {
    await login(page, 'accountant');
    const id = await uploadAndWait(page, invoicePdf('file.pdf'));
    const ok = await page.request.get(`/api/documents/${id}/file`);
    expect(ok.status()).toBe(200);
    expect(ok.headers()['content-type']).toBe('application/pdf');
    expect(ok.headers()['x-content-type-options']).toBe('nosniff');
    expect(ok.headers()['content-security-policy']).toBe('sandbox');

    const other = await page.context().browser()!.newContext();
    try {
      const anonymous = await other.request.get(`http://localhost:3000/api/documents/${id}/file`);
      expect(anonymous.status()).toBe(401);
    } finally {
      await other.close();
    }
  });

  test('an XML document is shown as text beside its form', async ({ page }) => {
    await login(page, 'accountant');
    const id = await uploadAndWait(page, invoiceXml('review.xml'));
    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(page.getByTestId('document-viewer')).toHaveAttribute('data-source', 'xml');
    await expect(page.getByTestId('text-viewer')).toContainText('<HDon>', { timeout: 30_000 });
  });

  test('a newer extraction never overwrites what the reviewer typed; loading it is their choice', async ({
    page,
  }) => {
    await login(page, 'accountant');
    const id = await uploadAndWait(page, invoicePdf('newer.pdf'));
    let newer = false;
    await page.route(`**/api/documents/${id}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (newer) body.extraction.id = '00000000-0000-4000-8000-00000000beef';
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(page.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('field-seller.name').fill('Gõ dở dang');
    newer = true; // the next poll/refocus returns another extraction id
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
    );
    await expect(page.getByTestId('newer-extraction')).toBeVisible();
    await expect(page.getByTestId('field-seller.name')).toHaveValue('Gõ dở dang');

    await page.getByTestId('newer-extraction').getByRole('button').click();
    await expect(page.getByTestId('newer-extraction')).toHaveCount(0);
    await expect(page.getByTestId('field-seller.name')).toHaveValue('Công ty SAMPLE Bán');
  });

  test('T3.5: correcting and approving saves the corrected values; afterwards the form is read-only', async ({
    page,
  }) => {
    const id = await openPdfReview(page);
    await page.getByTestId('field-seller.name').fill('Công ty SAMPLE Đã Sửa');
    await page.getByTestId('approve-form').click();

    await expect(page.getByTestId('approved-now')).toContainText('Bạn đã sửa 1 ô');
    await expect(page.getByTestId('approve-form')).toHaveCount(0);
    await expect(page.getByTestId('field-seller.name')).toHaveValue('Công ty SAMPLE Đã Sửa');
    await expect(page.getByTestId('field-seller.name')).toHaveAttribute('readonly', '');

    // A fresh load comes from the database: the approved value, not the AI's.
    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(page.getByTestId('field-seller.name')).toHaveValue('Công ty SAMPLE Đã Sửa');
    await expect(page.getByTestId('document-detail')).toContainText('Hoá đơn này đã được duyệt');
    await expect(page.getByTestId('approve-form')).toHaveCount(0);
  });

  test('T3.5: two tabs approve the same document; the later one gets 409 and keeps what it typed', async ({
    page,
    context,
  }) => {
    const id = await openPdfReview(page);
    const tabB = await context.newPage();
    await tabB.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(tabB.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });
    await tabB.getByTestId('field-seller.name').fill('Bản của tab B');

    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('approved-now')).toBeVisible();

    const answer = tabB.waitForResponse(
      (r) => r.url().endsWith(`/api/documents/${id}/approve`) && r.request().method() === 'POST',
    );
    await tabB.getByTestId('approve-form').click();
    expect((await answer).status()).toBe(409);
    await expect(tabB.getByTestId('approve-error')).toContainText('vừa được duyệt hoặc thay đổi');
    await expect(tabB.getByTestId('field-seller.name')).toHaveValue('Bản của tab B');

    // The page learned why: the choice to see the approved version is the person's.
    await tabB.getByTestId('newer-extraction').getByRole('button').click();
    await expect(tabB.getByTestId('field-seller.name')).toHaveValue('Công ty SAMPLE Bán');
    await expect(tabB.getByTestId('approve-form')).toHaveCount(0);
  });

  test('T3.5: the version sent is the one the form was loaded with, not the latest the page knows', async ({
    page,
  }) => {
    await login(page, 'accountant');
    const id = await uploadAndWait(page, invoicePdf('frozen.pdf'));
    let reopened = false;
    await page.route(`**/api/documents/${id}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (reopened) body.version = 2;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(page.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });

    reopened = true; // the next refetch says the document moved on
    const refetched = page.waitForResponse((r) => r.url().endsWith(`/api/documents/${id}`));
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
    );
    await refetched;
    await expect(page.getByTestId('review-screen')).toContainText('hiện là phiên bản 2');

    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/documents/${id}/approve`));
    await page.getByTestId('approve-form').click();
    expect((await sent).headers()['if-match']).toBe('"1"');
  });

  test('T3.5: a viewer is refused by the API whatever the page shows', async ({ page }) => {
    // The demo viewer belongs to another tenant, so this checks the permission on the real stack;
    // the missing button is checked in document-detail-screen.test.tsx.
    await login(page, 'viewer');
    const res = await page.request.post(
      '/api/documents/00000000-0000-4000-8000-00000000dead/approve',
      {
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          'if-match': '"1"',
        },
        data: {},
      },
    );
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_PERMISSION');
  });

  test('T3.5: closing the tab with unsaved edits asks first', async ({ page }) => {
    await openPdfReview(page);
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.dismiss();
    });
    await page.getByTestId('field-seller.name').click();
    await page.getByTestId('field-seller.name').fill('Chưa lưu');
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => dialogs).toEqual(['beforeunload']);
  });

  test('a field with a reason shows it as text, not only in a tooltip', async ({ page }) => {
    await openPdfReview(page);
    await expect(
      page.locator('[data-path="invoiceNo"]').locator('..').getByTestId('weak-reason'),
    ).toContainText('AI chỉ chắc 60%');
  });
});
