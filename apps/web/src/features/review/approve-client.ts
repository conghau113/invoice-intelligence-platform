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

const KIND_BY_STATUS: Readonly<Record<number, ApproveErrorKind>> = {
  400: 'invalid',
  401: 'session',
  403: 'forbidden',
  404: 'notFound',
  409: 'conflict',
  413: 'tooLarge',
  422: 'invalid',
};

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
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    if (res.status === 502 && body.code === 'API_UNREACHABLE') {
      return { ok: false, kind: 'unreachable' };
    }
    return { ok: false, kind: KIND_BY_STATUS[res.status] ?? 'error' };
  }
  const parsed = resultSchema.safeParse(await res.json().catch(() => null));
  // The approval happened; only the count is unknown, and a wrong shape is still not a success to show.
  return parsed.success
    ? { ok: true, corrections: parsed.data.corrections }
    : { ok: false, kind: 'error' };
}
