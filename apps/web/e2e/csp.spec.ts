import { expect, test, type Page } from '@playwright/test';
import { invoicePdf, uploadFile } from './support/documents';
import { login } from './support/login';

/**
 * T7.4: the Content-Security-Policy set by proxy.ts must block nothing the app itself needs. A
 * wrong policy shows up only in a real browser (a page that renders but never hydrates, a PDF that
 * never draws, a socket that never opens), so the screens that use scripts, the pdf.js worker,
 * blob images, the realtime socket and the sign-out redirect are walked here, and every violation
 * reported on our origin fails the test. Needs the worker and the AI service, like review.spec.ts.
 */

type Violation = { page: string; directive: string; blocked: string };

// Runs in every document before its own scripts (Playwright injects it, CSP does not apply), and
// reports through the console because a navigation would wipe anything kept on window.
async function watchViolations(page: Page): Promise<Violation[]> {
  const found: Violation[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(
        `CSP_VIOLATION ${JSON.stringify({
          page: location.origin + location.pathname,
          directive: e.effectiveDirective,
          blocked: e.blockedURI,
        })}`,
      );
    });
  });
  const ours = new URL(test.info().project.use.baseURL ?? 'http://localhost:3000').origin;
  page.on('console', (msg) => {
    const text = msg.text();
    if (!text.startsWith('CSP_VIOLATION ')) return;
    const v = JSON.parse(text.slice('CSP_VIOLATION '.length)) as Violation;
    // Keycloak's login pages have their own policy; only ours is under test.
    if (v.page.startsWith(ours)) found.push(v);
  });
  return found;
}

test.describe('content security policy', () => {
  test('every page carries a nonce-based CSP that differs per response', async ({ page }) => {
    const first = await page.goto('/vi/login');
    const second = await page.goto('/vi/login');
    const csp = first!.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(second!.headers()['content-security-policy']).not.toBe(csp);
    // Every <script> the server rendered carries that response's nonce. (Chunks Next loads later
    // from the client have none: 'strict-dynamic' lets a trusted script load them.)
    const nonce = /'nonce-([^']+)'/.exec(second!.headers()['content-security-policy']!)![1];
    const tags = (await second!.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
  });

  test('markup injected into the page cannot run script (inline handler, javascript: URL)', async ({
    page,
  }) => {
    const violations = await watchViolations(page);
    await page.goto('/vi/login');
    await page.waitForLoadState('networkidle');
    // What a stored XSS looks like once some code writes untrusted text as HTML.
    const ran = await page.evaluate(async () => {
      const w = window as unknown as { injected?: string };
      const box = document.createElement('div');
      box.innerHTML =
        '<img src="/does-not-exist.png" onerror="window.injected=\'onerror\'">' +
        '<a id="xss" href="javascript:window.injected=\'href\'">x</a>';
      document.body.append(box);
      (document.getElementById('xss') as HTMLAnchorElement).click();
      await new Promise((r) => setTimeout(r, 300));
      return w.injected ?? null;
    });
    expect(ran).toBeNull();
    await expect
      .poll(() =>
        violations.filter((v) => v.directive === 'script-src-attr' || v.blocked === 'inline'),
      )
      .not.toHaveLength(0);
  });

  test('the app works under the policy: dashboard, upload with realtime, PDF review, sign-out', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const violations = await watchViolations(page);
    const sockets: string[] = [];
    page.on('websocket', (ws) => sockets.push(ws.url()));

    // admin, not accountant: the suite signs in as accountant almost everywhere, and every page
    // here costs that user's per-minute read budget (rate limit), which the later specs then miss.
    await login(page, 'admin');
    for (const path of ['/vi/dashboard', '/vi/documents', '/vi/insights', '/vi/ask']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }

    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');
    await expect.poll(() => sockets.some((u) => u.includes('/realtime/socket.io/'))).toBe(true);
    const { id } = await uploadFile(page, invoicePdf('e2e-csp.pdf'));
    await page.goto('/vi/documents');
    await expect(page.getByTestId(`document-row-${id}`)).toHaveAttribute(
      'data-status',
      'needs_review',
      { timeout: 45_000 },
    );

    // pdf.js: its worker (worker-src) and the canvas it draws; the text layer only fills once the
    // worker has parsed the page.
    await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
    await expect(page.getByTestId('pdf-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.textLayer span').first()).toBeAttached({ timeout: 30_000 });

    // Sign-out posts a form to us and is redirected to Keycloak (form-action), then back.
    await page.getByTestId('logout').click();
    await expect(page).toHaveURL(/\/(vi|en)\/login/);

    expect(violations).toEqual([]);
  });
});
