/** One or two capital letters for the avatar: first letters of the first and last word, else of the email. */
export function initialsOf(name: string | null | undefined, email?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const source = words.length > 0 ? words : [(email ?? '').trim().split('@')[0] ?? ''];
  const first = Array.from(source[0] ?? '')[0] ?? '';
  const last = source.length > 1 ? (Array.from(source[source.length - 1] ?? '')[0] ?? '') : '';
  return `${first}${last}`.toLocaleUpperCase() || '?';
}
