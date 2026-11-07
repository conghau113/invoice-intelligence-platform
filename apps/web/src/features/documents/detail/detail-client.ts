import { InvoiceSchema, RuleWarningSchema, type BffErrorCode } from 'contracts';
import { z } from 'zod';
import { DOCUMENT_STATUSES } from '@/components/common/status-badge';
import { SOURCE_TYPES } from '../list-params';

const approvedInvoiceSchema = z.object({
  id: z.uuid(),
  documentVersion: z.number().int(),
  data: InvoiceSchema,
  warnings: z.array(RuleWarningSchema),
  approvedAt: z.iso.datetime(),
});

const detailSchema = z.object({
  id: z.uuid(),
  status: z.enum(DOCUMENT_STATUSES),
  sourceType: z.enum(SOURCE_TYPES),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  /** Why the document failed, a code from the API; shown through a translated message. */
  failureCode: z.string().nullable(),
  extraction: z
    .object({
      id: z.uuid(),
      documentVersion: z.number().int(),
      source: z.enum(SOURCE_TYPES),
      // The same schema the worker and the API validate with (packages/contracts).
      data: InvoiceSchema,
      warnings: z.array(RuleWarningSchema),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  /** What a person approved at the current version; the screen shows this instead of the AI's values. */
  invoice: approvedInvoiceSchema.nullable(),
  /** After a reopen: what was approved before. Not approved any more; the form starts from it. */
  reopenedFrom: approvedInvoiceSchema.nullable(),
});
export type DocumentDetail = z.infer<typeof detailSchema>;

/** Why a load failed, in the terms the screen explains to the user. */
export type DetailErrorKind = 'session' | 'forbidden' | 'notFound' | 'unreachable' | 'error';

export class DetailError extends Error {
  constructor(readonly kind: DetailErrorKind) {
    super(kind);
    this.name = 'DetailError';
  }
}

const kindOf = (status: number, code: unknown): DetailErrorKind => {
  if (status === 401) return 'session';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 502 && code === ('API_UNREACHABLE' satisfies BffErrorCode)) return 'unreachable';
  return 'error';
};

/** Browser side: calls the same-origin BFF route, which holds the token (ADR 0006). */
export async function fetchDocumentDetail(
  id: string,
  signal?: AbortSignal,
): Promise<DocumentDetail> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new DetailError('unreachable'); // the web server itself did not answer
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    throw new DetailError(kindOf(res.status, body.code));
  }
  const parsed = detailSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new DetailError('error'); // never render a shape we did not expect
  return parsed.data;
}
