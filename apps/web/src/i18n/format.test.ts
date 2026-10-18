import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, formatNumber } from './format';

const NBSP = ' ';

describe('formatMoney', () => {
  it('formats VND by locale (0 decimals)', () => {
    expect(formatMoney(1234567, 'VND', 'vi')).toBe(`1.234.567${NBSP}₫`);
    expect(formatMoney(1234567, 'VND', 'en')).toBe('₫1,234,567');
  });
  it('treats USD amounts as cents (2 decimals)', () => {
    expect(formatMoney(123450, 'USD', 'en')).toBe('$1,234.50');
    expect(formatMoney(123450, 'USD', 'vi')).toBe(`1.234,50${NBSP}US$`);
  });
  it('keeps every digit for large and negative amounts', () => {
    expect(formatMoney(9007199254740991, 'USD', 'en')).toBe('$90,071,992,547,409.91');
    expect(formatMoney(-5, 'USD', 'en')).toBe('-$0.05');
    expect(formatMoney(0, 'VND', 'en')).toBe('₫0');
  });
  it.each([1.5, Number.NaN, 2 ** 53])('rejects %s (not a safe integer of minor units)', (v) => {
    expect(() => formatMoney(v, 'VND', 'en')).toThrow(RangeError);
  });
});

describe('formatNumber', () => {
  it('uses the locale separators', () => {
    expect(formatNumber(1234567.5, 'vi')).toBe('1.234.567,5');
    expect(formatNumber(1234567.5, 'en')).toBe('1,234,567.5');
  });
});

describe('formatDate', () => {
  // 17:30Z is already the next day in Ho Chi Minh (UTC+7): the zone is fixed, not the server's.
  it('formats a timestamptz in the app time zone', () => {
    expect(formatDate('2026-10-18T17:30:00Z', 'en')).toBe('Oct 19, 2026');
    expect(formatDate('2026-10-18T17:30:00Z', 'vi')).toBe('19 thg 10, 2026');
  });
  it('rejects non-dates', () => {
    expect(() => formatDate('not-a-date', 'en')).toThrow(RangeError);
  });
});
