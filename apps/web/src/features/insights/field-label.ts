/**
 * The message key of a field path of /insights: `seller.taxCode` -> `sellerTaxCode`,
 * `lines.*.amount` -> `linesAmount`. Keys of next-intl cannot hold dots, hence camel case.
 */
export function fieldKey(path: string): string {
  return path
    .split('.')
    .filter((part) => part !== '*')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}
