import type vi from '../../messages/vi.json';
import type { routing } from './routing';

// Typed message keys: a wrong key in t('...') fails `tsc`.
declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof vi;
  }
}
