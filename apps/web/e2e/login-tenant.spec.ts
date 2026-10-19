import { expect, test } from '@playwright/test';
import { ACME_ID, GLOBEX_ID } from './support/accounts';
import { login } from './support/login';

test.describe('sign-in shows the data of the user own tenant only', () => {
  test('acme admin sees acme and nothing of globex', async ({ page }) => {
    await login(page, 'admin');
    await expect(page.getByTestId('dashboard-tenant')).toHaveText('acme');
    await expect(page.getByTestId('dashboard-tenant-id')).toHaveText(ACME_ID);
    await expect(page.locator('body')).not.toContainText(GLOBEX_ID);
    await expect(page.locator('body')).not.toContainText('globex');
  });

  test('globex viewer sees globex and nothing of acme', async ({ page }) => {
    await login(page, 'viewer');
    await expect(page.getByTestId('dashboard-tenant')).toHaveText('globex');
    await expect(page.getByTestId('dashboard-tenant-id')).toHaveText(GLOBEX_ID);
    await expect(page.locator('body')).not.toContainText(ACME_ID);
    await expect(page.locator('body')).not.toContainText('acme');
  });

  test('a forged tenant cookie does not move a globex user into acme', async ({
    page,
    context,
  }) => {
    await login(page, 'viewer');
    await context.addCookies([{ name: 'tenant', value: 'acme', url: 'http://localhost:3000' }]);
    await page.reload();
    await expect(page.getByTestId('dashboard-tenant')).toHaveText('globex');
    await expect(page.getByTestId('dashboard-tenant-id')).toHaveText(GLOBEX_ID);
  });

  test('the web server refuses to store a tenant that is not in the user token list', async ({
    page,
  }) => {
    await login(page, 'viewer');
    const res = await page.request.post('/api/tenant', {
      form: { tenant: 'acme', returnTo: '/vi/dashboard' },
      maxRedirects: 0,
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.status()).toBe(403);
    await page.goto('/vi/dashboard');
    await expect(page.getByTestId('dashboard-tenant')).toHaveText('globex');
  });
});
