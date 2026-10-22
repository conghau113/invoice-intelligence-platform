import { z } from 'zod';
import { DOCUMENT_STATUSES } from '@/components/common/status-badge';
import { SOURCE_TYPES, toApiQuery, type ListParams } from './list-params';

const pageSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(DOCUMENT_STATUSES),
      sourceType: z.enum(SOURCE_TYPES),
      version: z.number().int(),
      createdAt: z.iso.datetime(),
    }),
  ),
  meta: z.object({
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  }),
});
export type DocumentPage = z.infer<typeof pageSchema>;
export type DocumentRow = DocumentPage['items'][number];

/** Why a load failed, in the terms the screen explains to the user. */
export type ListErrorKind = 'session' | 'forbidden' | 'unreachable' | 'error';

export class ListError extends Error {
  constructor(readonly kind: ListErrorKind) {
    super(kind);
    this.name = 'ListError';
  }
}

const kindOf = (status: number, code: unknown): ListErrorKind => {
  if (status === 401) return 'session';
  if (status === 403) return 'forbidden';
  if (status === 502 && code === 'API_UNREACHABLE') return 'unreachable';
  return 'error';
};

/** Browser side: calls the same-origin BFF route, which holds the token (ADR 0006). */
export async function fetchDocuments(params: ListParams, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`/api/documents?${toApiQuery(params)}`, { signal, cache: 'no-store' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ListError('unreachable'); // the web server itself did not answer
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    throw new ListError(kindOf(res.status, body.code));
  }
  const parsed = pageSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ListError('error'); // never render a shape we did not expect
  return parsed.data;
}
