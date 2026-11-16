import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { invoiceXml, uploadFile } from './support/documents';
import { login } from './support/login';

/**
 * T6.5: in-app notifications. Needs the worker and the AI service like upload.spec.ts; the online
 * test also needs realtime switched on (REALTIME_TOKEN_SECRET, REALTIME_PUBLIC_URL), as
 * realtime.spec.ts does. Both halves of delivery: a push while the user is on the app (online), and
 * the stored list when they come back (offline).
 */
const ORIGIN = 'http://localhost:3000';

/** Start from zero unread, so the badge proves this test's notification and nothing older. */
async function readAll(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/notifications/read-all', { headers: { origin: ORIGIN } });
  expect(res.status()).toBe(204);
}

const item = (page: Page, documentId: string) =>
  page.locator(`[data-testid="notification-item"][href$="/documents/${documentId}"]`);

test.describe('in-app notifications', () => {
  test('online: the bell shows the end of an extraction without a reload', async ({ page }) => {
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await login(page, 'accountant');
    await readAll(page.request);
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');
    await expect.poll(() => sockets.some((u) => u.includes('/realtime/socket.io/'))).toBe(true);
    await expect(page.getByTestId('notification-badge')).toHaveCount(0);

    // Connected, the bell polls every 5 minutes: within this test only the event can bring it.
    const started = Date.now();
    const { status, id } = await uploadFile(page, invoiceXml('e2e-notification-online.xml'));
    expect(status).toBe(201);

    await expect(
      page.getByTestId('notification-badge'),
      'no badge: is realtime on and are the worker and the AI service running?',
    ).toHaveText('1', { timeout: 45_000 });
    console.log(`notification shown ${Date.now() - started} ms after the upload answered`);
    expect(page.url()).toContain('/vi/upload');

    await page.getByTestId('notification-bell').click();
    await expect(item(page, id)).toHaveAttribute('data-unread', 'true');
    await expect(item(page, id)).toContainText('Đã trích xuất xong');
  });

  test('offline: what finished while no tab was open is in the list on return, and stays read', async ({
    page,
    context,
  }) => {
    await login(page, 'accountant');
    await readAll(page.request);
    // Nobody is on the app: no page is open while the document is uploaded and processed.
    await page.close();
    const file = invoiceXml('e2e-notification-offline.xml');
    const upload = await context.request.post('/api/documents/upload', {
      headers: { origin: ORIGIN, 'idempotency-key': randomUUID() },
      multipart: { file },
    });
    expect(upload.status()).toBe(201);
    const { id } = (await upload.json()) as { id: string };
    await expect
      .poll(
        async () => {
          const res = await context.request.get(`/api/documents/${id}`);
          return ((await res.json()) as { status: string }).status;
        },
        { timeout: 45_000, message: 'not processed: are the worker and the AI service running?' },
      )
      .toBe('needs_review');

    // Back on the app, with sockets refused: only the stored list can show it.
    const back = await context.newPage();
    await back.routeWebSocket(/\/realtime\/socket\.io\//, (ws) => ws.close());
    await back.goto('/vi/documents');
    await expect(back.getByTestId('notification-badge')).toHaveText('1');
    await back.getByTestId('notification-bell').click();
    await expect(item(back, id)).toHaveAttribute('data-unread', 'true');

    // Opening it goes to the document and marks it read; a reload keeps it read.
    await item(back, id).click();
    // The detail page can take a while on a dev server's first compile (as in realtime.spec.ts).
    await expect(back).toHaveURL(new RegExp(`/vi/documents/${id}$`), { timeout: 30_000 });
    await expect(back.getByTestId('notification-badge')).toHaveCount(0);
    await back.reload();
    await expect(back.getByTestId('notification-bell')).toBeVisible();
    await expect(back.getByTestId('notification-badge')).toHaveCount(0);
    await back.getByTestId('notification-bell').click();
    await expect(item(back, id)).toHaveAttribute('data-unread', 'false');
  });
});
