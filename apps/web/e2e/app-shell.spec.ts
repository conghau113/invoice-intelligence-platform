import { expect, test, type Page } from '@playwright/test';
import { ACME_ID, GLOBEX_ID } from './support/accounts';
import { login } from './support/login';

const nav = (page: Page, id: string) => page.getByTestId(`nav-${id}`);

// Mirrors .claude/skills/ui-smoke/SKILL.md, steps 1-10.
test.describe('app shell', () => {
  test('1-2. viewer: read-only menu, no tenant dropdown; hand-typed members URL is a translated 404', async ({
    page,
  }) => {
    await login(page, 'viewer');
    for (const id of ['documents', 'ask', 'insights']) await expect(nav(page, id)).toBeVisible();
    for (const id of ['upload', 'members']) await expect(nav(page, id)).toHaveCount(0);
    await expect(page.getByTestId('tenant')).toHaveText('globex');
    await expect(page.getByTestId('tenant-switcher')).toHaveCount(0);

    await page.goto('/vi/settings/members');
    await expect(page.getByText('Không tìm thấy trang')).toBeVisible();
  });

  test('3. accountant: gains upload, still no members', async ({ page }) => {
    await login(page, 'accountant');
    await expect(nav(page, 'upload')).toBeVisible();
    await expect(nav(page, 'members')).toHaveCount(0);
  });

  test('4. admin: all five items, tenant acme', async ({ page }) => {
    await login(page, 'admin');
    for (const id of ['documents', 'upload', 'ask', 'insights', 'members'])
      await expect(nav(page, id)).toBeVisible();
    await expect(page.getByTestId('tenant')).toHaveText('acme');
  });

  test('5-6. consultant: switches acme to globex without signing in again', async ({ page }) => {
    await login(page, 'consultant');
    const switcher = page.getByTestId('tenant-switcher');
    await expect(switcher.locator('option')).toHaveText(['acme', 'globex']);
    await expect(page.getByTestId('dashboard-tenant-id')).toHaveText(ACME_ID);

    await switcher.selectOption('globex');
    await expect(page.getByTestId('dashboard-tenant')).toHaveText('globex');
    await expect(page.getByTestId('dashboard-tenant-id')).toHaveText(GLOBEX_ID);
  });

  test('7. language switch flips /vi and /en, menu text follows, chosen tenant is kept', async ({
    page,
  }) => {
    await login(page, 'consultant');
    await page.getByTestId('tenant-switcher').selectOption('globex');
    await expect(page.getByTestId('dashboard-tenant')).toHaveText('globex');
    await expect(nav(page, 'documents')).toHaveText('Tài liệu');

    await page.getByTestId('language-switcher').selectOption('en');
    await expect(page).toHaveURL(/\/en\/dashboard$/);
    await expect(nav(page, 'documents')).toHaveText('Documents');
    await expect(page.getByTestId('dashboard-tenant')).toHaveText('globex');

    await page.getByTestId('language-switcher').selectOption('vi');
    await expect(page).toHaveURL(/\/vi\/dashboard$/);
    await expect(nav(page, 'documents')).toHaveText('Tài liệu');
  });

  test('8. dark theme is applied and survives a reload', async ({ page }) => {
    await login(page, 'viewer');
    const html = page.locator('html');
    await expect(html).not.toHaveClass(/dark/);
    await page.getByTestId('theme-toggle').click();
    await expect(html).toHaveClass(/dark/);
    await page.reload();
    await expect(html).toHaveClass(/dark/);
  });

  test('9. 375px: sidebar hidden, drawer opens, closes on Escape, its links navigate, no horizontal scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await login(page, 'admin');
    await expect(page.getByTestId('sidebar-nav')).toBeHidden();
    // Measured on the shell itself, before navigating to the shell-less 404.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const drawer = page.getByTestId('mobile-menu');
    const item = page.getByTestId('mobile-nav-documents');
    await drawer.locator('summary').click();
    await expect(item).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(item).toBeHidden();

    await drawer.locator('summary').click();
    await item.click();
    // /documents does not exist until M2, so the target is the translated 404 (no shell there).
    await expect(page).toHaveURL(/\/vi\/documents$/);
  });

  test('9b. Escape right after opening the drawer closes it (no wait for the toggle event)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await login(page, 'admin');
    // Click and key in one task: the `toggle` event has not run yet. A slow CI runner hits the
    // same window with a fast user; the drawer must not depend on that event to hear Escape.
    await page.getByTestId('mobile-menu').evaluate((el) => {
      el.querySelector('summary')?.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await expect(page.getByTestId('mobile-nav-documents')).toBeHidden();
  });

  test('10. sign out returns to the login page and protects the dashboard', async ({ page }) => {
    await login(page, 'viewer');
    await page.getByTestId('logout').click();
    await expect(page).toHaveURL(/\/(vi|en)\/login/);
    await expect(page.getByTestId('login')).toBeVisible();

    await page.goto('/vi/dashboard');
    await expect(page).toHaveURL(/\/vi\/login/);
  });
});
