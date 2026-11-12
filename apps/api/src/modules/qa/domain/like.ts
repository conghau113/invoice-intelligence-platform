/**
 * A text the model wrote (a supplier or item name) as a "contains" pattern for `ILIKE … ESCAPE '\'`.
 * The text is still a bound parameter; escaping only stops `%` and `_` inside it from acting as
 * wildcards, so "100%" matches "100%" and "_" cannot match every name.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
