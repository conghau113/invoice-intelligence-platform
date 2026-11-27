/**
 * PII redaction for every log line (T7.2, SECURITY.md §7). The second line of defence: code must
 * not log document content in the first place (T3.6). This catches what slips through: a value
 * interpolated into a message, a library error that quotes its input.
 *
 * Two layers:
 * - by key: a field whose name says it holds a person's data loses its whole value;
 * - by pattern, in every string: emails, Vietnamese phone numbers, tax codes (MST), company names
 *   with a legal-form word, and person names that start with a common Vietnamese surname.
 *
 * Names are a heuristic: a name with a rare surname, or an English person name in free text
 * ("Keith Anderson"), is not caught. The rules are mirrored in apps/ai/app/logging.py and both
 * run the same cases from fixtures/redaction-cases.json.
 *
 * Every pattern is bounded (no nested unbounded repetition), so a long log line cannot make the
 * regex engine backtrack for ever.
 */

export const EMAIL = '[EMAIL]';
export const PHONE = '[PHONE]';
export const TAX_CODE = '[TAX_CODE]';
export const NAME = '[NAME]';
export const REDACTED = '[REDACTED]';

/** Field names (lower case, without `_`/`-`) whose value is always personal data. */
const SENSITIVE_KEYS = new Set([
  'email',
  'phone',
  'phonenumber',
  'tel',
  'mobile',
  'taxcode',
  'mst',
  'name',
  'fullname',
  'buyer',
  'seller',
  'address',
]);
/** Suffixes: `buyerName`, `seller_tax_code`, `contactEmail`, `billingAddress`... */
const SENSITIVE_SUFFIXES = [
  'email',
  'phone',
  'taxcode',
  'address',
  'fullname',
  'buyername',
  'sellername',
  'companyname',
  'customername',
  'personname',
];

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEYS.has(k) || SENSITIVE_SUFFIXES.some((s) => k.endsWith(s));
}

// Starts where the run of address characters starts, so a long local part is not cut in two
// (`aaaaaa[EMAIL]`); 256 is above the RFC's 64 and still bounded.
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,256}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,30}\.[A-Za-z]{2,24}/g;

// A letter or digit in any script: what may not touch a match on either side.
const WORD = String.raw`[\p{L}\p{N}]`;
const TOKEN = String.raw`[\p{L}\p{N}&.'-]{1,40}`;

/**
 * Words that start a company name ("Công ty TNHH ...", "Tập Đoàn ...") take the words after them,
 * up to the next punctuation; the English forms end the name ("Bridges Ltd", "Dennis and Sons").
 */
const COMPANY_PREFIX = `(?:tổng công ty|công ty|cty|tập đoàn|doanh nghiệp|hợp tác xã)`;
const COMPANY_PREFIX_RE = new RegExp(
  `(?<!${WORD})${COMPANY_PREFIX}(?!${WORD})(?: {1,3}${TOKEN}){0,8}`,
  'giu',
);
const CAP = String.raw`\p{Lu}[\p{L}'-]{0,30}`;
const COMPANY_SUFFIX_RE = new RegExp(
  String.raw`(?<!${WORD})${CAP}(?:, ${CAP}){0,3}(?: (?:and|&) ${CAP})?,? (?:Ltd\.?|LLC|JSC|Inc\.?|PLC|Corp\.?|Co\., Ltd\.?|and Sons|Group)(?!${WORD})`,
  'gu',
);

/** Common Vietnamese surnames, with and without diacritics (the short ASCII ones are too ambiguous). */
const SURNAMES = [
  'Nguyễn',
  'Trần',
  'Lê',
  'Phạm',
  'Hoàng',
  'Huỳnh',
  'Phan',
  'Vũ',
  'Võ',
  'Đặng',
  'Bùi',
  'Đỗ',
  'Hồ',
  'Ngô',
  'Dương',
  'Lý',
  'Đinh',
  'Trương',
  'Đào',
  'Lâm',
  'Mai',
  'Trịnh',
  'Lương',
  'Cao',
  'Nguyen',
  'Tran',
  'Pham',
  'Hoang',
  'Huynh',
  'Dang',
  'Bui',
  'Ngo',
  'Duong',
  'Truong',
  'Trinh',
];
const SURNAME_ALT = [...SURNAMES, ...SURNAMES.map((s) => s.toUpperCase())].join('|');
/** A surname and up to four words after it; `personName` keeps only the capitalised ones. */
const PERSON_RE = new RegExp(`(?<!${WORD})(?:${SURNAME_ALT})(?!${WORD})((?: ${TOKEN}){1,4})`, 'gu');

// Not inside a longer number: no letter or digit right before, and no "1-" or "0." (a range, a
// decimal). A dash after a word is fine ("MST-0101234567"). ASCII digits only, as in Python.
const NOT_IN_NUMBER = String.raw`(?<![\p{L}\p{N}])(?<![0-9][.-])`;
// 10 digits, or 13 for a branch, with or without the dash; a full stop may end it.
const TAX_CODE_RE = new RegExp(
  String.raw`${NOT_IN_NUMBER}[0-9]{10}(?:-?[0-9]{3})?(?![\p{L}\p{N}-]|\.[0-9])`,
  'gu',
);
// 0xx, (0xx), +84 xx or 84xx, then two groups; spaces, dots or dashes between groups.
const PHONE_RE = new RegExp(
  String.raw`${NOT_IN_NUMBER}(?<!\+)(?:\+84[ .-]?[0-9]{2,3}|84[0-9]{2,3}|0[0-9]{2,3}|\(0[0-9]{2,3}\))[ .-]?[0-9]{3,4}[ .-]?[0-9]{3,4}(?![\p{L}\p{N}]|-[\p{L}\p{N}])`,
  'gu',
);

function isCapitalised(word: string | undefined): boolean {
  return word !== undefined && /^\p{Lu}/u.test(word);
}

function personName(match: string, tail: string): string {
  const words = tail.split(' ').slice(1);
  let taken = 0;
  while (taken < words.length && isCapitalised(words[taken])) taken += 1;
  if (taken === 0) return match; // a surname alone ("Mai", "Cao") is not a name
  const rest = words.slice(taken);
  return rest.length === 0 ? NAME : `${NAME} ${rest.join(' ')}`;
}

/** Redacts PII patterns in one string. Order matters: emails first, numbers last. */
export function redactString(text: string): string {
  // NFC first: "Nguyễn" typed with combining marks would not match the surname list.
  return text
    .normalize('NFC')
    .replace(EMAIL_RE, EMAIL)
    .replace(COMPANY_PREFIX_RE, NAME)
    .replace(COMPANY_SUFFIX_RE, NAME)
    .replace(PERSON_RE, personName)
    .replace(TAX_CODE_RE, TAX_CODE)
    .replace(PHONE_RE, PHONE);
}

const MAX_DEPTH = 8;

/** An error as plain data: its class, and message and stack with PII redacted. */
function redactError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { type: err.name, message: redactString(err.message) };
  if (err.stack !== undefined) out.stack = redactString(err.stack);
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  return out;
}

/**
 * Returns a copy of `value` with PII removed: strings by pattern, fields by key, errors turned into
 * `{ type, message, stack, code }`, binary data into `[Binary]`. Numbers, booleans and nulls pass
 * unchanged. `[Circular]` only for a real cycle: the same object twice side by side is copied twice.
 */
export function redactValue(value: unknown, depth = 0, ancestors: object[] = []): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.includes(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (value instanceof Error) return redactError(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary]';
  const path = [...ancestors, value];
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, path));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] =
      isSensitiveKey(key) && v !== null && v !== undefined
        ? REDACTED
        : redactValue(v, depth + 1, path);
  }
  return out;
}
