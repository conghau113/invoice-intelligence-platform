'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';

// Same page, other locale: replace() keeps the path and updates the NEXT_LOCALE cookie.
// The query string is kept (the document list keeps its filters there). Known limit: no dynamic
// routes yet (revisit with [id] pages).
export function LanguageSwitcher() {
  const t = useTranslations('LanguageSwitcher');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  return (
    <select
      aria-label={t('label')}
      data-testid="language-switcher"
      value={locale}
      onChange={(e) =>
        router.replace(
          // Read at click time: useSearchParams() would force every page that shows the
          // switcher (login, styleguide) to be rendered per request or wrapped in Suspense.
          { pathname, query: Object.fromEntries(new URLSearchParams(window.location.search)) },
          { locale: e.target.value as Locale },
        )
      }
      className="rounded-md border border-input bg-card px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      {routing.locales.map((l) => (
        <option key={l} value={l}>
          {t(l)}
        </option>
      ))}
    </select>
  );
}
