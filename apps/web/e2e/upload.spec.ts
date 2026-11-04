import { expect, test } from '@playwright/test';
import { FAKE_LLM_SELLER, invoicePdf, invoiceXml, SELLER, uploadFile } from './support/documents';
import { login } from './support/login';

/**
 * The M2 demo as a browser test: upload an invoice XML, see it move through the queue and the
 * worker (real Redis, real AI service on the deterministic XML path, no LLM), open the detail page
 * and read the extracted data. Needs the worker and the AI service running (`pnpm dev:stack`, or
 * the e2e job of the CI workflow): without them the document stays `queued` and this test fails on
 * purpose, with a message that says so.
 */

test.describe('upload to extracted data', () => {
  test('XML goes through the queue and worker; the list shows it and the detail page its data', async ({
    page,
  }) => {
    await login(page, 'accountant');
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');

    const file = invoiceXml('e2e-invoice.xml');
    const { status, id } = await uploadFile(page, file);
    expect(status).toBe(201);
    await expect(page.getByTestId('upload-state-e2e-invoice.xml')).toHaveAttribute(
      'data-state',
      'done',
    );

    // The new document is in the list (newest first) and the worker takes it to needs_review.
    await page.goto('/vi/documents');
    const row = page.getByTestId(`document-row-${id}`);
    await expect(row).toBeVisible();
    await expect(
      row,
      'still not needs_review: are the worker (pnpm dev:worker) and the AI service (pnpm dev:ai) running?',
    ).toHaveAttribute('data-status', 'needs_review', { timeout: 45_000 });

    // The detail page shows what the parser read: seller and totals.
    await page.getByTestId(`document-link-${id}`).click();
    // Generous: `next dev` compiles the detail route on its first visit.
    await expect(page).toHaveURL(new RegExp(`/vi/documents/${id}$`), { timeout: 30_000 });
    await expect(page.getByTestId('invoice-data')).toBeVisible();
    await expect(page.getByTestId('field-seller.name')).toHaveValue(SELLER);
    await expect(page.getByTestId('field-total')).toBeVisible();
    await expect(page.getByTestId('invoice-lines').getByRole('row')).not.toHaveCount(1);
  });

  // T3.2: the same slice on the LLM path. Needs the AI service started with LLM_PROVIDER=fake
  // (the CI e2e job does; locally: `LLM_PROVIDER=fake pnpm dev:ai`), so no network or key is used.
  test('a PDF goes through the queue, worker and LLM path to needs_review with data', async ({
    page,
  }) => {
    await login(page, 'accountant');
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');

    const { status, id } = await uploadFile(page, invoicePdf('e2e-invoice.pdf'));
    expect(status).toBe(201);

    await page.goto('/vi/documents');
    const row = page.getByTestId(`document-row-${id}`);
    await expect(
      row,
      'not needs_review: are the worker and the AI service (LLM_PROVIDER=fake pnpm dev:ai) running?',
    ).toHaveAttribute('data-status', 'needs_review', { timeout: 45_000 });

    await page.getByTestId(`document-link-${id}`).click();
    await expect(page).toHaveURL(new RegExp(`/vi/documents/${id}$`), { timeout: 30_000 });
    await expect(page.getByTestId('field-seller.name')).toHaveValue(FAKE_LLM_SELLER);
    await expect(page.getByTestId('field-total')).toBeVisible();
  });

  // That no second job starts is proved in the API integration tests (documents-create, queue).
  test('the same bytes again answer 200 with the existing document, not a new one', async ({
    page,
  }) => {
    await login(page, 'accountant');
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');

    const file = invoiceXml('first.xml');
    const first = await uploadFile(page, file);
    const again = await uploadFile(page, { ...file, name: 'copy.xml' });

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.id).toBe(first.id);
    await expect(page.getByTestId('upload-state-copy.xml')).toHaveAttribute(
      'data-state',
      'duplicate',
    );
  });

  test('another tenant cannot see the document or open it by id', async ({ page, browser }) => {
    await login(page, 'accountant');
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');
    const { id } = await uploadFile(page, invoiceXml('acme-only.xml'));

    const other = await browser.newPage(); // takes baseURL from the Playwright config
    try {
      await login(other, 'viewer'); // viewer@globex.example
      await other.goto('/vi/documents');
      await expect(other.getByTestId('documents-screen')).toBeVisible();
      await expect(other.getByTestId(`document-row-${id}`)).toHaveCount(0);
      await other.goto(`/vi/documents/${id}`);
      await expect(other.getByTestId('invoice-data')).toHaveCount(0);
      await expect(other.getByText(SELLER)).toHaveCount(0);
    } finally {
      await other.close();
    }
  });
});
