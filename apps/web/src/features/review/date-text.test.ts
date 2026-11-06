import { InvoiceSchema } from 'contracts';
import { describe, expect, it } from 'vitest';
import { formatDateText, isIsoDate, parseDateText } from './date-text';

describe('formatDateText', () => {
  it.each([
    ['2026-01-08', 'vi', '08/01/2026'],
    ['2026-01-08', 'en', '01/08/2026'],
    ['2026-12-31', 'vi', '31/12/2026'],
    ['2024-02-29', 'vi', '29/02/2024'],
  ])('%s in %s is %s', (iso, locale, text) => {
    expect(formatDateText(iso, locale)).toBe(text);
  });

  it.each(['', '08/01', '2026-02-31', 'abc'])('leaves %j as it is: not a date', (text) => {
    expect(formatDateText(text, 'vi')).toBe(text);
  });
});

describe('parseDateText', () => {
  it.each([
    ['08/01/2026', 'vi', '2026-01-08'],
    ['8/1/2026', 'vi', '2026-01-08'],
    ['08-01-2026', 'vi', '2026-01-08'],
    ['08.01.2026', 'vi', '2026-01-08'],
    [' 08/01/2026 ', 'vi', '2026-01-08'],
    ['08/01/2026', 'en', '2026-08-01'],
    ['1/8/2026', 'en', '2026-01-08'],
    ['2026-01-08', 'vi', '2026-01-08'], // a pasted ISO date
  ])('%j in %s is %s', (text, locale, iso) => {
    expect(parseDateText(text, locale)).toBe(iso);
  });

  it.each(['', '08/01', '08/01/26', 'hôm qua', '31/02/2026', '45/01/2026', '08/13/2026'])(
    '%j never reaches the API: the schema refuses what comes out',
    (text) => {
      expect(InvoiceSchema.shape.issueDate.safeParse(parseDateText(text, 'vi')).success).toBe(
        false,
      );
    },
  );

  it.each(['vi', 'en'])('survives a round trip in %s, day and month not swapped', (locale) => {
    for (const iso of ['2026-01-08', '2026-08-01', '2026-12-31', '2024-02-29']) {
      expect(parseDateText(formatDateText(iso, locale), locale)).toBe(iso);
    }
  });
});

describe('isIsoDate', () => {
  it('accepts a calendar date only', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-1-8')).toBe(false);
  });
});
