import { defineRouting } from 'next-intl/routing';

// Locale in every URL (ADR 0007). Negotiation: NEXT_LOCALE cookie > Accept-Language > vi.
export const routing = defineRouting({
  locales: ['vi', 'en'],
  defaultLocale: 'vi',
  localePrefix: 'always',
});

export type Locale = (typeof routing.locales)[number];
