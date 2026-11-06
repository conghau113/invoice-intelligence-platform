/**
 * The review form keeps a date as ISO 8601 (what the schema, the API and the database use) and shows
 * it the way the interface language writes dates. A native `type="date"` cannot do this: it follows
 * the browser's language, not the page's. Day, month and year order comes from `Intl` (ADR 0007),
 * which covers any language writing a date as three numbers with the year last, as vi and en do. A
 * language that puts the year first would also need `TYPED_DATE` extended.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TYPED_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

const formatter = (locale: string) =>
  new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC', // the date is built in UTC below: no time zone can move it to another day
  });

/** A real calendar date in ISO form: 2026-02-31 has the right shape but is not one. */
export function isIsoDate(text: string): boolean {
  const hit = ISO_DATE.exec(text);
  if (!hit) return false;
  const date = new Date(Date.UTC(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3])));
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** `2026-01-08` as the locale writes it. Anything else is half-typed text: returned unchanged. */
export function formatDateText(iso: string, locale: string): string {
  return isIsoDate(iso) ? formatter(locale).format(new Date(`${iso}T00:00:00Z`)) : iso;
}

/**
 * What the person typed as ISO: `8/1/2026` in vi is `2026-01-08`, in en `2026-08-01`. Only reorders
 * and pads; text that is not a date stays as it is, so the schema rejects it and the form says why
 * (31/02/2026 becomes 2026-02-31, which the schema refuses too). A pasted ISO date passes through.
 */
export function parseDateText(text: string, locale: string): string {
  const trimmed = text.trim();
  const hit = TYPED_DATE.exec(trimmed);
  if (!hit) return trimmed;
  const order = formatter(locale)
    .formatToParts(new Date(0))
    .map((part) => part.type)
    .filter((type) => type === 'day' || type === 'month' || type === 'year');
  const at = (type: 'day' | 'month' | 'year') => hit[order.indexOf(type) + 1] ?? '';
  return `${at('year')}-${at('month').padStart(2, '0')}-${at('day').padStart(2, '0')}`;
}
