// Which explanation to show for a 403 from the API. Only known codes pick a specific text; anything
// else (including a value the API should never send) falls back to the generic one.
export const FORBIDDEN_HINTS = {
  TENANT_REQUIRED: 'forbiddenRequired',
  TENANT_NOT_MEMBER: 'forbiddenNotMember',
} as const;

export type ForbiddenHintKey =
  (typeof FORBIDDEN_HINTS)[keyof typeof FORBIDDEN_HINTS] | 'forbiddenHint';

export function forbiddenHintKey(code: string | undefined): ForbiddenHintKey {
  return code !== undefined && Object.hasOwn(FORBIDDEN_HINTS, code)
    ? FORBIDDEN_HINTS[code as keyof typeof FORBIDDEN_HINTS]
    : 'forbiddenHint';
}
