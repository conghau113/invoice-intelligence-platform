import { expect, test } from '@playwright/test';
import { login } from './support/login';

// T4.6: /insights reads GET /insights/extraction on the server and draws it, in both languages.
test.describe('insights', () => {
  test('viewer reaches the page from the menu; online and offline sections render', async ({
    page,
  }) => {
    await login(page, 'viewer');
    await page.getByTestId('nav-insights').click();
    await expect(page).toHaveURL(/\/vi\/insights$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Số liệu AI' })).toBeVisible();
    await expect(page.getByTestId('insights-online')).toBeVisible();
    // The API runs with EVAL_REPORTS_DIR (dev wrapper, CI env): the eval report is shown.
    const offline = page.getByTestId('insights-offline');
    await expect(
      offline.getByRole('list', { name: 'Độ chính xác theo field trên bộ kiểm thử' }),
    ).toBeVisible();
    await expect(offline.getByTestId('bar-seller.taxCode')).toBeVisible();
    await expect(page.getByTestId('insights-limits')).toBeVisible();
  });

  test('English, for the accountant of acme', async ({ page }) => {
    await login(page, 'accountant', 'en');
    await page.goto('/en/insights');
    await expect(page.getByRole('heading', { level: 1, name: 'AI insights' })).toBeVisible();
    await expect(page.getByText('Human correction rate per field')).toBeVisible();
    await expect(page.getByText('Accuracy on the test set')).toBeVisible();
  });
});
