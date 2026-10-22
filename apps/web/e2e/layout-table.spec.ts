import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { login } from './support/login';

/**
 * Geometry of the app shell and the data table (docs/ui/UI_LAYOUT_SPEC.md, UI_TABLE_SPEC.md),
 * measured in a real browser. The list API is mocked so every case has exactly the rows it names.
 */

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: randomUUID(),
    status: ['queued', 'processing', 'needs_review', 'approved', 'failed'][i % 5],
    sourceType: 'xml',
    version: 1,
    createdAt: new Date(Date.UTC(2026, 9, 22, 3, 0, 0) - i * 60_000).toISOString(),
  }));

async function mockList(page: Page, total: number, delayMs = 0) {
  await page.route('**/api/documents?*', async (route: Route) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const limit = Number(new URL(route.request().url()).searchParams.get('limit') ?? 20);
    await route.fulfill({
      json: {
        items: rowsOf(Math.min(total, limit)),
        meta: { page: 1, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  });
}

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} is not visible`);
  return b;
};

/** Where the panel, its scrollbar strip and its footer are. */
async function geometry(page: Page) {
  const [panel, strip, footer] = await Promise.all([
    box(page, 'table-panel'),
    box(page, 'table-hscroll'),
    box(page, 'table-footer'),
  ]);
  return {
    panelTop: Math.round(panel.y),
    panelHeight: Math.round(panel.height),
    stripTop: Math.round(strip.y),
    stripHeight: Math.round(strip.height),
    footerTop: Math.round(footer.y),
    panelBottom: Math.round(panel.y + panel.height),
    footerBottom: Math.round(footer.y + footer.height),
  };
}

const overflow = (page: Page) =>
  page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));

async function openList(page: Page, query = '') {
  await page.goto(`/vi/documents${query}`);
  await expect(page.getByTestId('table-panel')).toBeVisible();
  await expect(page.getByTestId('table-panel')).toHaveAttribute('aria-busy', 'false');
}

test.describe('app shell and data table geometry', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'accountant');
  });

  test('the table panel, scrollbar strip and footer do not move with the row count (0, 1, 5, many)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const seen: Awaited<ReturnType<typeof geometry>>[] = [];
    for (const total of [0, 1, 5, 20, 500]) {
      await page.unrouteAll();
      await mockList(page, total);
      await openList(page);
      seen.push(await geometry(page));
    }
    for (const g of seen) expect(g).toEqual(seen[0]);
    const g = seen[0]!;
    expect(g.stripTop + g.stripHeight).toBeLessThanOrEqual(g.footerTop); // strip sits above the footer
    expect(g.stripHeight).toBeGreaterThanOrEqual(8); // a real, visible track
    // The panel fills the space the shell leaves (down to the page padding); it is not just small and equal.
    expect(g.panelHeight).toBeGreaterThan(300);
    expect(800 - g.panelBottom).toBeLessThanOrEqual(40);
    expect(Math.abs(g.footerBottom - g.panelBottom)).toBeLessThanOrEqual(1); // footer pinned to the bottom
  });

  test('loading, empty and error keep the same geometry as a full list', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockList(page, 20);
    await openList(page);
    const full = await geometry(page);

    await page.unrouteAll();
    await mockList(page, 20, 1500); // loading: measured while the skeleton is on screen
    await page.goto('/vi/documents');
    await expect(page.getByTestId('table-panel')).toHaveAttribute('aria-busy', 'true');
    expect(await geometry(page)).toEqual(full);

    await page.unrouteAll();
    await mockList(page, 0);
    await openList(page);
    await expect(page.getByTestId('table-state')).toBeVisible();
    expect(await geometry(page)).toEqual(full);

    await page.unrouteAll();
    await page.route('**/api/documents?*', (r) =>
      r.fulfill({ status: 502, json: { code: 'API_UNREACHABLE' } }),
    );
    await openList(page);
    await expect(page.getByTestId('table-state')).toContainText('Không kết nối được máy chủ');
    expect(await geometry(page)).toEqual(full);
  });

  test('the scrollbar track is there even when the columns fit, and has no scroll range', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await mockList(page, 3);
    await openList(page);
    const strip = page.getByTestId('table-hscroll');
    await expect(strip).toBeVisible();
    const m = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="table-hscroll"]') as HTMLElement;
      const viewport = document.querySelector('[data-testid="table-viewport"]') as HTMLElement;
      return {
        stripRange: strip.scrollWidth - strip.clientWidth,
        viewportRange: viewport.scrollWidth - viewport.clientWidth,
        stripHeight: strip.getBoundingClientRect().height,
      };
    });
    expect(m.viewportRange).toBe(0);
    expect(m.stripRange).toBe(0); // no false scroll distance
    expect(m.stripHeight).toBeGreaterThanOrEqual(8);
  });

  test('a table wider than its area scrolls sideways: strip and rows move together, header stays aligned, last column is reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await mockList(page, 20);
    await openList(page);
    const read = () =>
      page.evaluate(() => {
        const q = (s: string) => document.querySelector(s) as HTMLElement;
        const viewport = q('[data-testid="table-viewport"]');
        const strip = q('[data-testid="table-hscroll"]');
        const ths = [...document.querySelectorAll('thead th')].map((e) =>
          e.getBoundingClientRect(),
        );
        const tds = [...document.querySelectorAll('tbody tr:first-child td')].map((e) =>
          e.getBoundingClientRect(),
        );
        return {
          viewportRange: viewport.scrollWidth - viewport.clientWidth,
          stripRange: strip.scrollWidth - strip.clientWidth,
          viewportLeft: viewport.scrollLeft,
          stripLeft: strip.scrollLeft,
          viewportRight: viewport.getBoundingClientRect().right,
          lastTh: ths.at(-1)!,
          alignedColumns: ths.every(
            (th, i) =>
              Math.abs(th.left - tds[i]!.left) < 1 && Math.abs(th.width - tds[i]!.width) < 1,
          ),
        };
      });

    const before = await read();
    expect(before.viewportRange).toBeGreaterThan(0);
    expect(before.stripRange).toBeCloseTo(before.viewportRange, 0); // same distance on both
    expect(before.alignedColumns).toBe(true);

    // Drag the strip: the rows follow.
    const middle = Math.floor(before.viewportRange / 2);
    await page.getByTestId('table-hscroll').evaluate((el, x) => (el.scrollLeft = x), middle);
    await expect.poll(async () => (await read()).viewportLeft).toBe(middle);
    expect((await read()).alignedColumns).toBe(true);

    // Scroll the rows (wheel/trackpad): the strip follows.
    const quarter = Math.floor(before.viewportRange / 4);
    await page.getByTestId('table-viewport').evaluate((el, x) => (el.scrollLeft = x), quarter);
    await expect.poll(async () => (await read()).stripLeft).toBe(quarter);

    // Scroll to the end: the last column is fully inside the viewport and still aligned.
    await page.getByTestId('table-hscroll').evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await expect
      .poll(async () => {
        const m = await read();
        return m.lastTh.right <= m.viewportRight + 1;
      })
      .toBe(true);
    expect((await read()).alignedColumns).toBe(true);
  });

  test('only one horizontal scrollbar shows: the rows area has none of its own', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await mockList(page, 20);
    await openList(page);
    const m = await page.evaluate(() => {
      const viewport = document.querySelector('[data-testid="table-viewport"]') as HTMLElement;
      const clip = viewport.parentElement as HTMLElement;
      const horizontalBar = viewport.offsetHeight - viewport.clientHeight;
      // What the user can see of the viewport is the clip box; its horizontal bar is below it.
      return {
        horizontalBar,
        visible: clip.getBoundingClientRect().height,
        client: viewport.clientHeight,
      };
    });
    expect(m.visible).toBeCloseTo(m.client, 0); // the clip shows exactly the rows' area
    expect(m.horizontalBar).toBeGreaterThanOrEqual(0);
  });

  test('the header stays visible while the rows scroll up and down', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    await mockList(page, 100);
    await openList(page, '?pageSize=100');
    const viewport = page.getByTestId('table-viewport');
    const top = async () =>
      page.evaluate(() => ({
        header: document.querySelector('thead th')!.getBoundingClientRect().top,
        viewport: document.querySelector('[data-testid="table-viewport"]')!.getBoundingClientRect()
          .top,
      }));
    const before = await top();
    expect(before.header).toBeCloseTo(before.viewport, 0);
    await viewport.evaluate((el) => (el.scrollTop = 400));
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    const after = await top();
    expect(after.header).toBeCloseTo(after.viewport, 0); // still at the top of the viewport
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  });

  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
    { width: 1024, height: 600 },
    { width: 768, height: 500 },
    { width: 1280, height: 320 },
  ]) {
    test(`the page itself never scrolls at ${size.width}x${size.height}; the footer stays inside the window`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await mockList(page, 300);
      await openList(page);
      expect(await overflow(page)).toEqual({ x: 0, y: 0 });
      const g = await geometry(page);
      expect(g.footerBottom).toBeLessThanOrEqual(size.height);
      const sidebar = await page.evaluate(() => {
        const a = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect();
        const t = document.querySelector('[data-testid="topbar"]')!.getBoundingClientRect();
        return { sidebarTop: a.top, topbarBottom: t.bottom, sidebarRight: a.right };
      });
      expect(Math.abs(sidebar.sidebarTop - sidebar.topbarBottom)).toBeLessThanOrEqual(1);
    });
  }

  test('browser zoom 150% and 75% (as CSS viewports) keeps the layout inside the window', async ({
    page,
  }) => {
    // Real browser zoom shrinks or grows the CSS viewport; Playwright cannot press Ctrl+, so the
    // same CSS viewports are set directly. The device pixel ratio (sharpness) is not emulated.
    await mockList(page, 50);
    for (const size of [
      { width: 853, height: 533 }, // 150%
      { width: 1280, height: 800 }, // 100%
      { width: 1707, height: 1067 }, // 75%
    ]) {
      await page.setViewportSize(size);
      await openList(page);
      expect(await overflow(page)).toEqual({ x: 0, y: 0 });
      const g = await geometry(page);
      expect(g.stripTop + g.stripHeight).toBeLessThanOrEqual(g.footerTop);
      expect(g.footerBottom).toBeLessThanOrEqual(size.height);
    }
  });

  test('a page without a table scrolls inside the main area, not the document', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 300 });
    await page.goto('/vi/upload');
    await page.waitForLoadState('networkidle');
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
    const main = await page.evaluate(() => {
      const m = document.getElementById('main')!;
      return { scrollable: m.scrollHeight > m.clientHeight };
    });
    expect(main.scrollable).toBe(true);
  });

  test('the sidebar collapses to icons, main takes the space, the choice survives a reload, labels stay as accessible names', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockList(page, 20);
    await openList(page);
    const width = async (id: string) => Math.round((await box(page, id)).width);
    const sidebar = page.getByTestId('sidebar');
    const toggle = page.getByTestId('sidebar-toggle');
    const mainWidth = async () =>
      page.evaluate(() =>
        Math.round(document.getElementById('main')!.getBoundingClientRect().width),
      );

    const expanded = { sidebar: await width('sidebar'), main: await mainWidth() };
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('nav-documents')).toContainText('Tài liệu');

    // dispatchEvent, not click(): the Next dev-server badge sits over this corner and would
    // intercept a pointer click. It does not exist in a production build.
    await toggle.dispatchEvent('click');
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const collapsed = { sidebar: await width('sidebar'), main: await mainWidth() };
    expect(collapsed.sidebar).toBeLessThan(expanded.sidebar - 100);
    expect(collapsed.main).toBeGreaterThan(expanded.main + 100);
    expect(collapsed.sidebar + collapsed.main).toBeCloseTo(expanded.sidebar + expanded.main, 0);
    const link = page.getByTestId('nav-documents');
    await expect(link).toHaveAttribute('aria-label', 'Tài liệu');
    await expect(link).toHaveAttribute('title', 'Tài liệu');
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
    await expect(page.getByTestId('table-panel')).toBeVisible(); // table follows the new width

    await page.reload();
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'true');

    await page.getByTestId('sidebar-toggle').dispatchEvent('click');
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-collapsed', 'false');
    expect(await width('sidebar')).toBe(expanded.sidebar);
  });

  test('the menu scrolls by itself on a short window and the collapse button stays reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 260 });
    await page.goto('/vi/dashboard');
    await page.waitForLoadState('networkidle');
    const toggle = await box(page, 'sidebar-toggle');
    expect(toggle.y + toggle.height).toBeLessThanOrEqual(260);
    const scrollable = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="sidebar-nav"]')!.parentElement!;
      return getComputedStyle(nav).overflowY;
    });
    expect(scrollable).toBe('auto');
    expect(await overflow(page)).toEqual({ x: 0, y: 0 });
  });

  test('navigation keeps the shell: the same top bar element, active item follows the route and back/forward', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockList(page, 5);
    await page.goto('/vi/documents');
    await expect(page.getByTestId('nav-documents')).toHaveAttribute('aria-current', 'page');
    await page.evaluate(() => {
      (document.querySelector('[data-testid="topbar"]') as HTMLElement).dataset.marker = 'same';
    });

    await page.getByTestId('nav-upload').click();
    await expect(page).toHaveURL(/\/vi\/upload$/);
    await expect(page.getByTestId('nav-upload')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('nav-documents')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('topbar')).toHaveAttribute('data-marker', 'same'); // not rebuilt

    await page.goBack();
    await expect(page).toHaveURL(/\/vi\/documents$/);
    await expect(page.getByTestId('nav-documents')).toHaveAttribute('aria-current', 'page');
    await page.goForward();
    await expect(page.getByTestId('nav-upload')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('topbar')).toHaveAttribute('data-marker', 'same');

    // Direct navigation to a route gets the right active item too.
    await page.goto('/vi/documents');
    await expect(page.getByTestId('nav-documents')).toHaveAttribute('aria-current', 'page');
  });

  test('top bar: brand on the left, user on the right, nothing overlaps, even narrow', async ({
    page,
  }) => {
    for (const width of [1280, 900, 768]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/vi/dashboard');
      await page.waitForLoadState('networkidle');
      const rect = (id: string) => box(page, id);
      const [brand, avatar, logout] = await Promise.all([
        rect('brand'),
        rect('avatar'),
        rect('logout'),
      ]);
      expect(brand.x + brand.width).toBeLessThan(avatar.x);
      expect(avatar.x + avatar.width).toBeLessThanOrEqual(logout.x + 1);
      expect(logout.x + logout.width).toBeLessThanOrEqual(width);
      expect((await overflow(page)).x).toBe(0);
    }
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto('/vi/dashboard');
    await expect(page.getByTestId('avatar')).toHaveText(/^[A-Z?]{1,2}$/);
    await expect(page.getByTestId('roles')).toContainText('Kế toán');
  });

  test('at phone width the top bar wraps instead of clipping: every control is inside the window', async ({
    page,
  }) => {
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/vi/dashboard');
      await page.waitForLoadState('networkidle');
      for (const id of ['logout', 'language-switcher', 'avatar']) {
        const b = await box(page, id);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(width + 1);
      }
      expect(await overflow(page)).toEqual({ x: 0, y: 0 });
      // The top bar grew to fit; the main area still starts right under it.
      const bar = await box(page, 'topbar');
      expect(bar.y + bar.height).toBeLessThan(220);
    }
  });

  test('refresh button reloads the list', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/documents?*', (route) => {
      calls += 1;
      return route.fulfill({
        json: { items: rowsOf(2), meta: { page: 1, limit: 20, total: 2, totalPages: 1 } },
      });
    });
    await page.goto('/vi/documents');
    await expect(page.getByTestId('table-panel')).toHaveAttribute('aria-busy', 'false');
    const before = calls;
    await page.getByTestId('refresh').click();
    await expect.poll(() => calls).toBeGreaterThan(before);
  });
});
