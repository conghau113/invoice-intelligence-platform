// Pure Intl helpers (no React). Money is integer minor units; dates are ISO 8601 / timestamptz.
import { TIME_ZONE } from './time-zone';

const BCP47: Record<string, string> = { vi: 'vi-VN', en: 'en-US' };
const tag = (locale: string) => BCP47[locale] ?? locale;

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

/** `minor` = smallest unit: VND has 0 decimals (1234567 = 1.234.567 ₫), USD has 2 (123450 = $1,234.50). */
export function formatMoney(minor: number, currency: 'VND' | 'USD', locale: string): string {
  if (!Number.isSafeInteger(minor))
    throw new RangeError('money must be a safe integer of minor units');
  const nf = new Intl.NumberFormat(tag(locale), { style: 'currency', currency });
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 0;
  // Decimal string, not minor / 10 ** digits: a double loses the last cents above ~2^53 / 100.
  const abs = String(Math.abs(minor)).padStart(digits + 1, '0');
  const cut = abs.length - digits;
  const decimal = `${minor < 0 ? '-' : ''}${abs.slice(0, cut)}${digits > 0 ? `.${abs.slice(cut)}` : ''}`;
  return nf.format(decimal as `${number}`); // Intl formats numeric strings exactly
}

export function formatDate(
  iso: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid ISO 8601 date');
  return new Intl.DateTimeFormat(tag(locale), { ...options, timeZone: TIME_ZONE }).format(date);
}
