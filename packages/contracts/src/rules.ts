import { z } from 'zod';
import { FieldPathSchema, TAX_CODE, type Invoice } from './invoice';

// Business rules (PRD section 5, AI_PIPELINE.md section 3). Pure and synchronous, so the worker,
// the API (when saving a correction) and the web form (while typing) run the very same code.
// A rule violation is a WARNING on a field: nothing here ever changes a number.
// A warning carries a fixed `code`, the field `path` and numeric `params` only, never text taken
// from the document (CLAUDE.md: document content is never logged), and no sentence either: the
// UI maps `code` to vi/en messages.

export const RULE_CODES = [
  'LINES_SUM_MISMATCH', // sum of lines[].amount != subtotal           (path: subtotal)
  'LINE_AMOUNT_MISMATCH', // round(quantity * unitPrice) != amount      (path: lines.i.amount)
  'TOTAL_MISMATCH', // subtotal + sum of VAT != total                  (path: total)
  'TOTAL_ZERO', // the sums agree but the total is 0                   (path: total)
  'TAX_CODE_FORMAT', // not 10 digits or 10-3 digits                    (path: *.taxCode)
  'ISSUE_DATE_FUTURE', // date after today in Vietnam                   (path: issueDate)
  'CURRENCY_NOT_ALLOWED', // outside ALLOWED_CURRENCIES                 (path: currency)
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

export const RuleWarningSchema = z.strictObject({
  code: z.enum(RULE_CODES),
  path: FieldPathSchema,
  // expected / actual amounts or the allowed list size: numbers only.
  params: z.record(z.string(), z.number()),
});
export type RuleWarning = z.infer<typeof RuleWarningSchema>;

/** PRD section 5.3, v1. */
export const ALLOWED_CURRENCIES: readonly string[] = ['VND', 'USD', 'EUR', 'JPY'];

/** PRD section 5.1: rounding tolerance of one minor unit. */
export const MONEY_TOLERANCE = 1;

/** "Today" as a calendar date in Vietnam (API.md uses Asia/Ho_Chi_Minh for whole days). */
export const todayInVietnam = (now: Date): string => {
  // Build YYYY-MM-DD from the parts, so the result does not depend on how a locale orders them.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

/** Same limit as `aiExtractResponseSchema.warnings`: a stored list is never longer. */
export const MAX_WARNINGS = 100;

/** Joins warning lists, dropping repeats of the same code + path, capped at MAX_WARNINGS. */
export function mergeWarnings(...lists: RuleWarning[][]): RuleWarning[] {
  const seen = new Set<string>();
  const out: RuleWarning[] = [];
  for (const w of lists.flat()) {
    const key = `${w.code}|${w.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length === MAX_WARNINGS) break;
  }
  return out;
}

const differs = (expected: number, actual: number): boolean =>
  Math.abs(expected - actual) > MONEY_TOLERANCE;

/**
 * Runs every rule. `today` is a parameter (YYYY-MM-DD) so the result is deterministic and the
 * caller picks the clock; use `todayInVietnam(new Date())`.
 */
export function checkInvoice(invoice: Invoice, today: string): RuleWarning[] {
  const out: RuleWarning[] = [];

  const linesSum = invoice.lines.reduce((s, l) => s + l.amount, 0);
  if (differs(linesSum, invoice.subtotal)) {
    out.push({
      code: 'LINES_SUM_MISMATCH',
      path: 'subtotal',
      params: { expected: linesSum, actual: invoice.subtotal },
    });
  }

  invoice.lines.forEach((line, i) => {
    const expected = Math.round(line.quantity * line.unitPrice);
    if (differs(expected, line.amount)) {
      out.push({
        code: 'LINE_AMOUNT_MISMATCH',
        path: `lines.${i}.amount`,
        params: { expected, actual: line.amount },
      });
    }
  });

  const vat = invoice.vatBreakdown.reduce((s, v) => s + v.amount, 0);
  if (differs(invoice.subtotal + vat, invoice.total)) {
    out.push({
      code: 'TOTAL_MISMATCH',
      path: 'total',
      params: { expected: invoice.subtotal + vat, actual: invoice.total },
    });
  } else if (invoice.total === 0) {
    // Sums cannot see a document that talked the model into zeroing every amount (LLM01). A real
    // zero invoice exists (free goods), so this only asks a human to look. Not raised next to
    // TOTAL_MISMATCH: that field is already flagged, a second message adds nothing.
    out.push({ code: 'TOTAL_ZERO', path: 'total', params: {} });
  }

  if (!TAX_CODE.test(invoice.seller.taxCode)) {
    out.push({ code: 'TAX_CODE_FORMAT', path: 'seller.taxCode', params: {} });
  }
  if (invoice.buyer.taxCode !== null && !TAX_CODE.test(invoice.buyer.taxCode)) {
    out.push({ code: 'TAX_CODE_FORMAT', path: 'buyer.taxCode', params: {} });
  }

  // Both are YYYY-MM-DD, so comparing as strings is comparing as dates.
  if (invoice.issueDate > today) {
    out.push({ code: 'ISSUE_DATE_FUTURE', path: 'issueDate', params: {} });
  }

  if (!ALLOWED_CURRENCIES.includes(invoice.currency)) {
    out.push({
      code: 'CURRENCY_NOT_ALLOWED',
      path: 'currency',
      params: { allowed: ALLOWED_CURRENCIES.length },
    });
  }

  return out;
}

/** Every addressable field path of this invoice (lines and VAT rows expanded). */
export function invoiceFieldPaths(invoice: Invoice): string[] {
  const paths = [
    'seller.name',
    'seller.taxCode',
    'seller.address',
    'buyer.name',
    'buyer.taxCode',
    'buyer.address',
    'invoiceNo',
    'series',
    'issueDate',
    'currency',
    'subtotal',
    'total',
  ];
  invoice.lines.forEach((_, i) => {
    for (const f of ['description', 'quantity', 'unit', 'unitPrice', 'vatRate', 'amount'])
      paths.push(`lines.${i}.${f}`);
  });
  invoice.vatBreakdown.forEach((_, i) => {
    for (const f of ['rate', 'base', 'amount']) paths.push(`vatBreakdown.${i}.${f}`);
  });
  return paths;
}
