/** Returned as 428 when the header is absent or is not one document version. */
export const IF_MATCH_REQUIRED = 'IF_MATCH_REQUIRED';

/** A strong entity tag holding the version (RFC 9110): `"3"`. `*` would skip the check, so it is refused. */
const VERSION_TAG = /^"([1-9][0-9]{0,8})"$/;

export function parseIfMatch(header: string | undefined): number | null {
  const match = header === undefined ? null : VERSION_TAG.exec(header);
  return match === null ? null : Number(match[1]);
}
