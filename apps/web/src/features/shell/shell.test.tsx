import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../messages/en.json';
import { TenantSwitcher } from './tenant-switcher';

vi.mock('@/i18n/navigation', () => ({ usePathname: () => '/documents' }));

const render = (tenants: string[], current: string) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <TenantSwitcher tenants={tenants} current={current} />
    </NextIntlClientProvider>,
  );

describe('TenantSwitcher', () => {
  it('offers every tenant of the user, selects the current one, returns to this page', () => {
    const html = render(['acme', 'globex'], 'globex');
    expect(html).toContain('action="/api/tenant"');
    expect(html).toContain('name="returnTo" value="/en/documents"');
    expect(html).toMatch(/<option value="acme"[^>]*>acme<\/option>/);
    expect(html).toMatch(/<option value="globex" selected=""[^>]*>globex<\/option>/);
  });

  it('shows just the name when there is nothing to switch to', () => {
    const html = render(['acme'], 'acme');
    expect(html).not.toContain('<select');
    expect(html).toContain('data-testid="tenant"');
  });
});
