'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';

/**
 * Plain form POST to /api/tenant: works without client state, and the server re-validates the
 * choice. With a single tenant there is nothing to switch, so only the name is shown.
 */
export function TenantSwitcher({
  tenants,
  current,
}: Readonly<{ tenants: readonly string[]; current: string }>) {
  const t = useTranslations('Shell');
  const locale = useLocale();
  const pathname = usePathname();
  if (tenants.length < 2) {
    return (
      <span data-testid="tenant" className="text-sm font-medium">
        {current}
      </span>
    );
  }
  return (
    <form action="/api/tenant" method="post" className="flex items-center gap-2">
      <input type="hidden" name="returnTo" value={`/${locale}${pathname}`} />
      <select
        name="tenant"
        aria-label={t('tenantLabel')}
        data-testid="tenant-switcher"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-md border border-input bg-card px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        {tenants.map((alias) => (
          <option key={alias} value={alias}>
            {alias}
          </option>
        ))}
      </select>
      {/* Keyboard / no-JS fallback for the auto-submit above. */}
      <button type="submit" className="sr-only">
        {t('tenantSwitch')}
      </button>
    </form>
  );
}
