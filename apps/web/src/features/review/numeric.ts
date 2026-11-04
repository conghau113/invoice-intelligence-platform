// Text <-> number for the form's numeric inputs. Money stays integer minor units (CLAUDE.md): the
// text is parsed with string arithmetic, never `float * 100`, so 1234.56 cannot become 123455.99.

/** Fraction digits of a currency in the smallest unit (VND, JPY 0; USD, EUR 2). */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 0
    );
  } catch {
    return 0; // not even well-formed (the schema only needs three capitals, so this is rare)
  }
}

/** `minor` as an editable string in major units: (123450, 2) -> "1234.5", (1234567, 0) -> "1234567". */
export function formatMinor(minor: number, digits: number): string {
  if (!Number.isSafeInteger(minor)) return '';
  const abs = String(Math.abs(minor)).padStart(digits + 1, '0');
  const cut = abs.length - digits;
  const frac = abs.slice(cut).replace(/0+$/, '');
  return `${minor < 0 ? '-' : ''}${abs.slice(0, cut)}${frac ? `.${frac}` : ''}`;
}

// A trailing mark ("1.") is a number still being typed: it reads as 1, the text stays as typed.
const MINOR_TEXT = /^(-?)([0-9]+)(?:[.,]([0-9]*))?$/;

/** Inverse of formatMinor. Spaces are ignored; `.` or `,` is the decimal mark. NaN when it is not a number or has more decimals than the currency allows. */
export function parseMinor(text: string, digits: number): number {
  const m = MINOR_TEXT.exec(text.replace(/\s/g, ''));
  if (!m) return Number.NaN;
  const [, sign, whole, frac = ''] = m;
  if (frac.length > digits) return Number.NaN;
  const minor = Number(`${whole}${frac.padEnd(digits, '0')}`);
  return Number.isSafeInteger(minor) ? (sign === '-' ? -minor : minor) : Number.NaN;
}

const DECIMAL_TEXT = /^(-?[0-9]+)(?:[.,]([0-9]*))?$/;

/** Plain decimal (quantity, VAT rate). NaN when it is not a number. */
export function parseDecimal(text: string): number {
  const m = DECIMAL_TEXT.exec(text.replace(/\s/g, ''));
  if (!m) return Number.NaN;
  // "1.500" is 1500 to a Vietnamese reader and 1.5 to an English one: refuse to guess.
  if (m[2]?.length === 3 && !/^-?0$/.test(m[1] ?? '')) return Number.NaN;
  const n = Number(`${m[1]}${m[2] ? `.${m[2]}` : ''}`); // "1." -> 1
  return Number.isFinite(n) ? n : Number.NaN;
}

export const formatDecimal = (n: number): string => (Number.isFinite(n) ? String(n) : '');
