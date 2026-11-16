import { expect, test } from '@playwright/test';
import { invoiceXml, uploadFile } from './support/documents';
import { login } from './support/login';

/**
 * T6.4: progress pushed over Socket.IO. Needs the worker and the AI service, like upload.spec.ts,
 * and realtime switched on (REALTIME_TOKEN_SECRET in the API, REALTIME_PUBLIC_URL in the web for a
 * production build; `pnpm dev:stack` sets both).
 */
test.describe('realtime progress', () => {
  test('the upload screen follows the worker without a reload: only an event can do that', async ({
    page,
  }) => {
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await login(page, 'accountant');
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');
    await expect.poll(() => sockets.some((u) => u.includes('/realtime/socket.io/'))).toBe(true);

    // The upload screen never polls: from here on, any read of the API is a mistake of this test.
    const reads: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/documents') && r.method() === 'GET') reads.push(r.url());
    });
    const name = 'e2e-realtime.xml';
    const { status } = await uploadFile(page, invoiceXml(name));
    expect(status).toBe(201);

    const badge = page.getByTestId(`upload-row-${name}`).locator('[data-status]');
    await expect(
      badge,
      'still not needs_review: is realtime on (REALTIME_TOKEN_SECRET, REALTIME_PUBLIC_URL) and are the worker and the AI service running?',
    ).toHaveAttribute('data-status', 'needs_review', { timeout: 45_000 });
    expect(page.url()).toContain('/vi/upload');
    expect(reads).toEqual([]);
  });

  test("another tab's approval reaches a form being edited at once; what was typed is kept", async ({
    page,
    context,
  }) => {
    await login(page, 'accountant');
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');
    const { id } = await uploadFile(page, invoiceXml('e2e-realtime-two-tabs.xml'));
    await page.goto('/vi/documents');
    await expect(page.getByTestId(`document-row-${id}`)).toHaveAttribute(
      'data-status',
      'needs_review',
      { timeout: 45_000 },
    );
    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(page.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });

    const tabB = await context.newPage();
    await tabB.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(tabB.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });
    await tabB.getByTestId('field-seller.name').fill('Bản của tab B');

    await page.getByTestId('approve-form').click();
    await expect(page.getByTestId('approved-now')).toBeVisible();

    // A document waiting for review is not polled: only the event can tell tab B, before any click.
    await expect(tabB.getByTestId('newer-extraction')).toBeVisible({ timeout: 10_000 });
    await expect(tabB.getByTestId('field-seller.name')).toHaveValue('Bản của tab B');
  });

  test('with the socket blocked, the list falls back to polling and still gets there', async ({
    page,
  }) => {
    // Every socket is refused at once, as a proxy that does not pass WebSocket would.
    await page.routeWebSocket(/\/realtime\/socket\.io\//, (ws) => ws.close());
    await login(page, 'accountant');
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');
    const { id } = await uploadFile(page, invoiceXml('e2e-realtime-fallback.xml'));

    await page.goto('/vi/documents');
    await expect(page.getByTestId(`document-row-${id}`)).toHaveAttribute(
      'data-status',
      'needs_review',
      { timeout: 45_000 },
    );
  });
});
