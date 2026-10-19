import { expect, type Page } from '@playwright/test';
import { DEMO_PASSWORD, USERS, type UserKey } from './accounts';

/**
 * Signs in through the real Keycloak login. Keycloak with Organizations asks for the username
 * first and the password on a second screen (TASKS.md, Phát sinh T1.5), so both steps are walked.
 */
export async function login(page: Page, user: UserKey, locale: 'vi' | 'en' = 'vi'): Promise<void> {
  await page.goto(`/${locale}/login`);
  await page.getByTestId('login').click();
  await page.locator('input[name="username"]').fill(USERS[user].email);
  await page.locator('#kc-login').click();
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/dashboard$`));
  // Client components (drawer, selects) only react after hydration; acting earlier is a race.
  await page.waitForLoadState('networkidle');
}
