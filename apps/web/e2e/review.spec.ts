import { expect, test, type Page } from '@playwright/test';
import { contrastRatio } from '../src/styles/contrast';
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

    // invoiceNo: confidence 0.6 -> low confidence, yellow. series: no meta at all -> only a light mark.
    const invoiceNo = page.locator('[data-weak][data-path="invoiceNo"]');
    await expect(invoiceNo).toBeVisible();
    await invoiceNo.hover();
    await expect(page.getByRole('tooltip').first()).toContainText('AI tự đánh giá chỉ chắc 60%');
    await expect(page.locator('[data-no-meta][data-path="series"]')).toBeVisible();
    await expect(page.locator('[data-weak][data-path="series"]')).toHaveCount(0);

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
    // A new line has no confidence from the AI: lightly marked; its empty text fails the schema.
    await expect(page.locator('[data-no-meta][data-path="lines.1.amount"]')).toBeVisible();
    // ...and the reason is visible text, once under the table instead of on every line.
    await expect(page.getByTestId('lines-card').getByTestId('no-meta-note')).toContainText(
      'AI không cho biết độ tin cậy',
    );
    await expect(page.getByTestId('line-notes-1')).toHaveCount(0);
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

  test('T3.9: a failure with no specific message says the reason from the shared code list', async ({
    page,
  }) => {
    const id = await openPdfReview(page);
    await page.route(`**/api/documents/${id}/approve`, (route) =>
      route.fulfill({ status: 500, json: { code: 'EXTRACTION_DATA_INVALID' } }),
    );
    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('approve-error')).toContainText(
      'Dữ liệu trích xuất đã lưu bị lỗi',
    );
    await page.route(`**/api/documents/${id}/approve`, (route) =>
      route.fulfill({ status: 500, json: { code: 'Nguyen Van A' } }),
    );
    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('approve-error')).toContainText('Không duyệt được');
    await expect(page.getByTestId('approve-error')).not.toContainText('Nguyen Van A');
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

  test('T3.8: approve, reopen, correct and approve again without reloading the page', async ({
    page,
  }) => {
    const id = await openPdfReview(page);
    await page.getByTestId('field-seller.name').fill('Công ty SAMPLE Lần Một');
    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('approved-now')).toBeVisible();

    await page.getByTestId('reopen').click();

    // Opens with what was approved, not the AI's value, and can be edited at once.
    const name = page.getByTestId('field-seller.name');
    await expect(name).toHaveValue('Công ty SAMPLE Lần Một');
    await expect(name).not.toHaveAttribute('readonly', '');
    await expect(page.getByTestId('review-screen')).toContainText('Đang sửa lại từ bản đã duyệt');
    await expect(page.getByTestId('approved-now')).toHaveCount(0);
    await expect(page.getByTestId('reopen')).toHaveCount(0);

    await name.fill('Công ty SAMPLE Lần Hai');
    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/documents/${id}/approve`));
    await page.getByTestId('approve-form').click();
    expect((await sent).headers()['if-match']).toBe('"2"');
    // Still compared with the AI: one field differs, however many times it was edited.
    await expect(page.getByTestId('approved-now')).toContainText('Bạn đã sửa 1 ô');

    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(page.getByTestId('field-seller.name')).toHaveValue('Công ty SAMPLE Lần Hai');
    await expect(page.getByTestId('document-detail')).toContainText('Hoá đơn này đã được duyệt');
    await expect(page.getByTestId('reopen')).toBeVisible();
  });

  test('T3.8: two tabs reopen the same invoice; the later one gets 409 and follows the document', async ({
    page,
    context,
  }) => {
    const id = await openPdfReview(page);
    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('approved-now')).toBeVisible();

    const tabB = await context.newPage();
    await tabB.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(tabB.getByTestId('reopen')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('reopen').click();
    await expect(page.getByTestId('approve-form')).toBeVisible();

    const answer = tabB.waitForResponse((r) => r.url().endsWith(`/api/documents/${id}/reopen`));
    await tabB.getByTestId('reopen').click();
    expect((await answer).status()).toBe(409);
    await expect(tabB.getByTestId('reopen-error')).toContainText('vừa được thay đổi');
    await expect(tabB.getByTestId('review-screen')).toContainText('Đang sửa lại từ bản đã duyệt');
    await expect(tabB.getByTestId('approve-form')).toBeVisible();
  });

  test('T3.8: a form being edited keeps what was typed when the document is reopened elsewhere', async ({
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
    await page.getByTestId('reopen').click();
    await expect(page.getByTestId('approve-form')).toBeVisible();

    const answer = tabB.waitForResponse((r) => r.url().endsWith(`/api/documents/${id}/approve`));
    await tabB.getByTestId('approve-form').click();
    expect((await answer).status()).toBe(409);
    await expect(tabB.getByTestId('field-seller.name')).toHaveValue('Bản của tab B');
    await expect(tabB.getByTestId('newer-extraction')).toContainText('hiện là phiên bản 2');
  });

  test('T3.8: an approved form marks no AI doubts; the reopened form shows them again', async ({
    page,
  }) => {
    await openPdfReview(page);
    const invoiceNoMark = page.locator('[data-weak="true"][data-path="invoiceNo"]');
    await expect(invoiceNoMark.first()).toBeVisible();

    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('reopen')).toBeVisible();
    await expect(invoiceNoMark).toHaveCount(0);

    await page.getByTestId('reopen').click();
    await expect(page.getByTestId('approve-form')).toBeVisible();
    await expect(invoiceNoMark.first()).toBeVisible();
  });

  test('T3.8: a viewer is refused by the API whatever the page shows', async ({ page }) => {
    await login(page, 'viewer');
    const res = await page.request.post(
      '/api/documents/00000000-0000-4000-8000-00000000dead/reopen',
      { headers: { origin: 'http://localhost:3000', 'if-match': '"1"' } },
    );
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_PERMISSION');
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
    ).toContainText('AI tự đánh giá chỉ chắc 60%');
  });
});

/** Changes what the page reads for this document; the API and the database are not touched. */
async function withExtraction(page: Page, id: string, change: (data: ExtractedData) => void) {
  await page.route(`**/api/documents/${id}`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    change(body.extraction.data);
    await route.fulfill({ response: res, json: body });
  });
}

type ExtractedData = {
  fieldMeta: Record<
    string,
    { confidence: number; evidence: { page: number; text: string } | null } | undefined
  >;
  lines: { quantity: number }[];
};

async function openWith(page: Page, change: (data: ExtractedData) => void): Promise<string> {
  await login(page, 'accountant');
  const id = await uploadAndWait(page, invoicePdf('t37.pdf'));
  await withExtraction(page, id, change);
  await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
  await expect(page.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });
  return id;
}

const background = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('T3.7: which fields ask for attention', () => {
  test('an invoice that only lacks confidence has no warning field; low confidence and a broken rule are still yellow', async ({
    page,
  }) => {
    await openWith(page, (data) => {
      delete data.fieldMeta['invoiceNo'];
    });

    // Most fields have no confidence (fake.py gives only `total` one here), and none looks like a warning.
    await expect(page.locator('[data-no-meta]').first()).toBeVisible();
    expect(await page.locator('[data-no-meta]').count()).toBeGreaterThan(10);
    await expect(page.locator('[data-weak]')).toHaveCount(0);
    await expect(page.getByTestId('weak-icon')).toHaveCount(0);

    const plain = await background(page, 'field-total');
    expect(await background(page, 'field-series')).toBe(plain);
    await expect(page.getByTestId('field-series')).toHaveCSS('border-style', 'dashed');
    await expect(page.getByTestId('field-total')).toHaveCSS('border-style', 'solid');
    // The reason is words, not only a colour or a frame.
    await expect(page.getByTestId('seller').getByTestId('no-meta-note')).toHaveText(
      'Ô viền đứt: AI không cho biết độ tin cậy.',
    );
    await expect(page.getByTestId('field-series')).toHaveAccessibleDescription(
      'AI không cho biết độ tin cậy.',
    );
    await expect(page.getByTestId('field-lines.0.unit')).toHaveAccessibleDescription(
      'AI không cho biết độ tin cậy.',
    );
    // A clean form must not read as a checked one (SECURITY.md section 6).
    await expect(page.getByTestId('warnings')).toContainText('chưa phải là đã xác minh');

    // A broken rule on the same screen is a real warning.
    await page.getByTestId('field-lines.0.amount').fill('1200000');
    const amount = page.locator('[data-weak][data-path="lines.0.amount"]');
    await expect(amount).toBeVisible();
    await expect(amount.getByTestId('weak-icon')).toBeVisible();
    expect(await background(page, 'field-lines.0.amount')).not.toBe(plain);
  });

  test('low confidence is yellow, unlike a field the AI said nothing about', async ({ page }) => {
    await openPdfReview(page);
    await expect(page.locator('[data-weak][data-path="invoiceNo"]')).toBeVisible();
    const plain = await background(page, 'field-total');
    expect(await background(page, 'field-invoiceNo')).not.toBe(plain);
    expect(await background(page, 'field-series')).toBe(plain);
  });

  test('the warning icon stays off the number in the narrowest cell, and the number is not cut', async ({
    page,
  }) => {
    await openWith(page, (data) => {
      data.fieldMeta['lines.0.quantity'] = { confidence: 0.5, evidence: null };
      data.fieldMeta['lines.0.vatRate'] = { confidence: 0.5, evidence: null };
      data.fieldMeta['total'] = { confidence: 0.5, evidence: null };
    });

    for (const path of ['lines.0.quantity', 'lines.0.vatRate', 'total']) {
      const cell = page.locator(`[data-weak][data-path="${path}"]`);
      const icon = await cell.getByTestId('weak-icon').boundingBox();
      expect(icon, path).not.toBeNull();
      const text = await page.getByTestId(`field-${path}`).evaluate((el) => {
        const input = el as HTMLInputElement;
        const style = getComputedStyle(input);
        const context = document.createElement('canvas').getContext('2d')!;
        context.font = style.font;
        const measured = context.measureText(input.value);
        const box = input.getBoundingClientRect();
        const right =
          box.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        const height = measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent;
        return {
          left: right - measured.width,
          right,
          top: box.top + (box.height - height) / 2,
          bottom: box.top + (box.height + height) / 2,
          value: input.value,
          cut: input.scrollWidth > input.clientWidth,
        };
      });
      expect(text.value, path).not.toBe('');
      expect(text.cut, `${path}: the value does not fit`).toBe(false);
      const apart =
        icon!.x >= text.right ||
        icon!.x + icon!.width <= text.left ||
        icon!.y >= text.bottom ||
        icon!.y + icon!.height <= text.top;
      expect(apart, `${path}: icon ${JSON.stringify(icon)} over text ${JSON.stringify(text)}`).toBe(
        true,
      );
    }

    // In the first row too, the scrolling table must not cut the icon off.
    const table = await page.locator('[data-slot="table-container"]').first().boundingBox();
    const first = await page
      .locator('[data-path="lines.0.quantity"]')
      .getByTestId('weak-icon')
      .boundingBox();
    expect(first!.y).toBeGreaterThanOrEqual(table!.y);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`marks are readable in the ${theme} theme`, async ({ page, context }) => {
      await context.addCookies([{ name: 'theme', value: theme, url: 'http://localhost:3000' }]);
      await openPdfReview(page);

      const colours = await page.evaluate(() => {
        const hex = (rgb: string) =>
          `#${(rgb.match(/\d+/g) ?? [])
            .slice(0, 3)
            .map((n) => Number(n).toString(16).padStart(2, '0'))
            .join('')}`;
        const read = (selector: string, property: 'color' | 'borderTopColor' | 'backgroundColor') =>
          hex(getComputedStyle(document.querySelector(selector)!)[property]);
        const reason = (path: string) => `[data-path="${path}"] ~ [data-testid="weak-reason"]`;
        return {
          card: read('[data-testid="seller"]', 'backgroundColor'),
          noMetaText: read('[data-testid="seller"] [data-testid="no-meta-note"]', 'color'),
          noMetaBorder: read('[data-path="series"] input', 'borderTopColor'),
          warningText: read(reason('invoiceNo'), 'color'),
          icon: read('[data-path="invoiceNo"] [data-testid="weak-icon"]', 'color'),
          iconBackground: read(
            '[data-path="invoiceNo"] [data-testid="weak-icon"]',
            'backgroundColor',
          ),
          warningValue: read('[data-path="invoiceNo"] input', 'color'),
          warningField: read('[data-path="invoiceNo"] input', 'backgroundColor'),
        };
      });
      expect(contrastRatio(colours.noMetaText, colours.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colours.noMetaBorder, colours.card)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(colours.warningText, colours.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colours.icon, colours.iconBackground)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(colours.warningValue, colours.warningField)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

test.describe('T3.7: the issue date follows the interface language, whatever the browser language', () => {
  test('shown in the interface language; an unchanged date is not a correction', async ({
    page,
  }) => {
    const id = await openPdfReview(page); // Desktop Chrome here is en-US: a native date box would show 01/15/2026
    const date = page.getByTestId('field-issueDate');
    await expect(date).toHaveValue('15/01/2026');
    await expect(date).toHaveAttribute('type', 'text');
    // All ten characters fit next to the calendar button.
    expect(await date.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.getByTestId('document-detail')).toContainText('Dạng ngày/tháng/năm.');

    await page.goto(`/en/documents/${id}`, { timeout: 30_000 });
    await expect(date).toHaveValue('01/15/2026');
    await expect(page.getByTestId('document-detail')).toContainText('Format: month/day/year.');

    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/documents/${id}/approve`));
    await page.getByTestId('approve-form').click();
    expect((await sent).postDataJSON().issueDate).toBe('2026-01-15');
    await expect(page.getByTestId('approved-now')).toContainText('Bạn không sửa ô nào');
  });

  test('typing 08/01/2026 sends 2026-01-08, and the saved value reads 08/01/2026 again', async ({
    page,
  }) => {
    const id = await openPdfReview(page);
    const date = page.getByTestId('field-issueDate');
    await date.fill('8/1/2026');
    await date.blur();
    await expect(date).toHaveValue('08/01/2026');

    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/documents/${id}/approve`));
    await page.getByTestId('approve-form').click();
    expect((await sent).postDataJSON().issueDate).toBe('2026-01-08');
    await expect(page.getByTestId('approved-now')).toContainText('Bạn đã sửa 1 ô');

    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(date).toHaveValue('08/01/2026');
    await expect(date).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Chọn ngày trên lịch' })).toHaveCount(0);
  });

  test('a date that does not exist cannot be approved; a future date warns', async ({ page }) => {
    await openPdfReview(page);
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/') && r.method() !== 'GET') writes.push(r.url());
    });
    const date = page.getByTestId('field-issueDate');
    await date.fill('31/02/2026');
    await date.blur();
    await expect(date).toHaveValue('31/02/2026'); // kept as typed, so the person can fix it
    await expect(date).toHaveAttribute('aria-invalid', 'true');
    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('approved-now')).toHaveCount(0);
    expect(writes).toEqual([]);

    await date.fill('01/01/2999');
    await expect(
      page.getByTestId('warnings').locator('li[data-code="ISSUE_DATE_FUTURE"]'),
    ).toBeVisible();
    await expect(page.locator('[data-weak][data-path="issueDate"]')).toBeVisible();
  });

  test('the calendar writes through the same ISO value, also over text that was not a date', async ({
    page,
  }) => {
    await openPdfReview(page);
    const date = page.getByTestId('field-issueDate');
    await date.fill('31/02/2026');
    await expect(date).toHaveAttribute('aria-invalid', 'true');
    await page.getByTestId('field-issueDate-picker').fill('2026-03-09');
    await expect(date).toHaveValue('09/03/2026');
    await expect(date).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: 'Chọn ngày trên lịch' })).toBeVisible();
  });

  test('switching the language in the app rewrites the date; what was typed is still sent as ISO', async ({
    page,
  }) => {
    const id = await openPdfReview(page);
    await expect(page.getByTestId('field-issueDate')).toHaveValue('15/01/2026');
    await page.getByTestId('language-switcher').selectOption('en');
    await expect(page).toHaveURL(new RegExp(`/en/documents/${id}`));
    const date = page.getByTestId('field-issueDate');
    await expect(date).toHaveValue('01/15/2026');
    await date.fill('01/08/2026'); // January in en
    const sent = page.waitForRequest((r) => r.url().endsWith(`/api/documents/${id}/approve`));
    await page.getByTestId('approve-form').click();
    expect((await sent).postDataJSON().issueDate).toBe('2026-01-08');
  });

  test('the calendar button shows the evidence like the box does, and never throws if the browser refuses', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      HTMLInputElement.prototype.showPicker = () => {
        throw new DOMException('refused', 'NotAllowedError');
      };
    });
    await openWith(page, (data) => {
      data.fieldMeta['issueDate'] = {
        confidence: 0.9,
        evidence: { page: 1, text: 'Tong thanh toan: 687,000 VND' },
      };
    });
    await page.getByRole('button', { name: 'Chọn ngày trên lịch' }).click();
    await expect(page.getByTestId('evidence-caption')).toContainText('Tong thanh toan');
    expect(errors).toEqual([]);
    await expect(page.getByTestId('field-issueDate')).toHaveValue('15/01/2026');
  });
});
