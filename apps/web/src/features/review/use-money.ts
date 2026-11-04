import { useLocale } from 'next-intl';
import { formatMoney, formatNumber } from '@/i18n/format';

/** formatMoney knows VND and USD only; any other ISO code is shown as a plain number plus the code. */
export function useMoney(currency: string): (minor: number) => string {
  const locale = useLocale();
  return (minor) => {
    if (!Number.isSafeInteger(minor)) return '—';
    return currency === 'VND' || currency === 'USD'
      ? formatMoney(minor, currency, locale)
      : `${formatNumber(minor, locale)} ${currency}`;
  };
}
