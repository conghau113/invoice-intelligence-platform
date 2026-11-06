import type { Invoice } from 'contracts';
import { z } from 'zod';

const resultSchema = z.object({ corrections: z.number().int().min(0) });

/** Why an approval did not happen, in the terms the form explains (`Review.approveError.<kind>`). */
export type ApproveErrorKind =
  | 'conflict'
  | 'session'
  | 'forbidden'
  | 'notFound'
  | 'invalid'
  | 'tooLarge'
  | 'unreachable'
  | 'error';

export type ApproveOutcome =
  { ok: true; corrections: number } | { ok: false; kind: ApproveErrorKind };

/** Why a reopen did not happen (`Review.reopenError.<kind>`): it has no body to be refused. */
export type ReopenErrorKind = Exclude<ApproveErrorKind, 'invalid' | 'tooLarge'> | 'limit';

export type ReopenOutcome = { ok: true } | { ok: false; kind: ReopenErrorKind };

const KIND_BY_STATUS: Readonly<Record<number, ApproveErrorKind>> = {
  400: 'invalid',
  401: 'session',
  403: 'forbidden',
  404: 'notFound',
  409: 'conflict',
  413: 'tooLarge',
  422: 'invalid',
};

async function failureOf(res: Response): Promise<{ kind: ApproveErrorKind; code: unknown }> {
  const { code } = (await res.json().catch(() => ({}))) as { code?: unknown };
  if (res.status === 502 && code === 'API_UNREACHABLE') return { kind: 'unreachable', code };
  return { kind: KIND_BY_STATUS[res.status] ?? 'error', code };
}

/**
 * Browser side: posts to the same-origin BFF route. `version` must be the one the form was loaded
 * with, not the latest the page knows: a form loaded before a change is exactly what the API has to
 * refuse, and sending the newer number would let it through.
 */
export async function approveDocument(
  id: string,
  version: number,
  invoice: Invoice,
): Promise<ApproveOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
      body: JSON.stringify(invoice),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (!res.ok) return { ok: false, kind: (await failureOf(res)).kind };
  const parsed = resultSchema.safeParse(await res.json().catch(() => null));
  // The approval happened; only the count is unknown, and a wrong shape is still not a success to show.
  return parsed.success
    ? { ok: true, corrections: parsed.data.corrections }
    : { ok: false, kind: 'error' };
}

/** Same rule for `version` as above: the one the person was looking at when they asked to reopen. */
export async function reopenDocument(id: string, version: number): Promise<ReopenOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(id)}/reopen`, {
      method: 'POST',
      headers: { 'if-match': `"${version}"` },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (res.ok) return { ok: true };
  const { kind, code } = await failureOf(res);
  // Also a 409, but nothing changed: telling the person to look again would not help them.
  if (code === 'REOPEN_LIMIT_REACHED') return { ok: false, kind: 'limit' };
  return { ok: false, kind: kind === 'invalid' || kind === 'tooLarge' ? 'error' : kind };
}
