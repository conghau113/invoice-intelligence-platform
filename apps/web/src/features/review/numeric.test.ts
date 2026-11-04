import { describe, expect, it } from 'vitest';
import { formatDecimal, formatMinor, minorDigits, parseDecimal, parseMinor } from './numeric';

describe('minorDigits', () => {
  it.each([
    ['VND', 0],
    ['JPY', 0],
    ['USD', 2],
    ['EUR', 2],
    ['XXZ', 2], // a well-formed code Intl does not know: its default of 2
  ])('%s -> %i', (c, d) => expect(minorDigits(c)).toBe(d));
});

describe('formatMinor / parseMinor', () => {
  it.each([
    [1234567, 0, '1234567'],
    [123450, 2, '1234.5'],
    [5, 2, '0.05'],
    [-250, 2, '-2.5'],
    [0, 2, '0'],
  ])('%i with %i digits -> "%s" and back', (minor, digits, text) => {
    expect(formatMinor(minor, digits)).toBe(text);
    expect(parseMinor(text, digits)).toBe(minor);
  });

  it('does not lose a cent where float arithmetic would (1.15 * 100 = 114.99999999999999)', () => {
    expect(parseMinor('1.15', 2)).toBe(115);
    expect(parseMinor('0,29', 2)).toBe(29);
  });

  it.each([
    ['', 0],
    ['abc', 0],
    ['1.5', 0], // VND has no fraction
    ['1.234', 2], // too many decimals
    ['1..2', 2],
    ['1e3', 0],
    ['99999999999999999999', 0], // beyond a safe integer
  ])('rejects "%s"', (text, digits) => expect(parseMinor(text, digits)).toBeNaN());

  it('ignores spaces typed as thousand separators', () => {
    expect(parseMinor('1 234 567', 0)).toBe(1234567);
  });
});

describe('a number still being typed does not flash an error', () => {
  it('a trailing mark reads as the whole number', () => {
    expect(parseDecimal('1.')).toBe(1);
    expect(parseDecimal('3,')).toBe(3);
    expect(parseMinor('12.', 2)).toBe(1200);
    expect(parseMinor('5,', 0)).toBe(5);
  });
});

describe('parseDecimal', () => {
  it.each([
    ['2', 2],
    ['1.5', 1.5],
    ['1,5', 1.5],
    ['-3', -3],
  ])('"%s" -> %d', (t, n) => expect(parseDecimal(t)).toBe(n));
  it.each(['1.500', '2,500', '-12.000'])('refuses "%s": thousands or decimals is a guess', (t) =>
    expect(parseDecimal(t)).toBeNaN(),
  );
  it('still accepts three decimals under one, and two or four decimals', () => {
    expect(parseDecimal('0.125')).toBe(0.125);
    expect(parseDecimal('1.25')).toBe(1.25);
    expect(parseDecimal('1.2500')).toBe(1.25);
  });
  it.each(['', 'x', '.5', '1e2', '1..2'])('rejects "%s"', (t) => expect(parseDecimal(t)).toBeNaN());
  it('formatDecimal gives "" for NaN so a bad entry shows empty', () => {
    expect(formatDecimal(Number.NaN)).toBe('');
    expect(formatDecimal(10)).toBe('10');
  });
});

describe('money text follows the currency digits', () => {
  it('the same minor units read differently when VND (0) becomes USD (2)', () => {
    expect(formatMinor(1000, minorDigits('VND'))).toBe('1000');
    expect(formatMinor(1000, minorDigits('USD'))).toBe('10');
    expect(parseMinor('10', minorDigits('USD'))).toBe(1000);
  });
});
