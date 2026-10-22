import { z } from 'zod';
import { DOCUMENT_STATUSES, type DocumentStatus } from './document-status';
import { SOURCE_TYPES, type SourceType } from './file-type';

export const INVALID_QUERY = 'INVALID_QUERY';

export const SORTS = ['-createdAt', 'createdAt'] as const;
export type DocumentSort = (typeof SORTS)[number];

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
/** A page number beyond this is refused: OFFSET reads and discards every earlier row. */
export const MAX_PAGE = 10_000;

/** `from` and `to` are calendar days in this zone (the same one the web formats dates in). */
export const LIST_TIME_ZONE = 'Asia/Ho_Chi_Minh';

/** The query after validation: also what a cache key (T6.3) is built from. */
export interface DocumentListQuery {
  page: number;
  limit: number;
  sort: DocumentSort;
  status?: DocumentStatus;
  type?: SourceType;
  /** Inclusive first day, YYYY-MM-DD. */
  from?: string;
  /** Inclusive last day, YYYY-MM-DD. */
  to?: string;
}

export class InvalidQueryError extends Error {
  readonly code = INVALID_QUERY;
  constructor() {
    super('The query parameters are not valid');
    this.name = 'InvalidQueryError';
  }
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s); // rejects 2026-02-30
  });

const schema = z.strictObject({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  sort: z.enum(SORTS).default('-createdAt'),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  type: z.enum(SOURCE_TYPES).optional(),
  from: day.optional(),
  to: day.optional(),
});

/** Throws InvalidQueryError; its message never contains the input. */
export function parseDocumentListQuery(raw: unknown): DocumentListQuery {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new InvalidQueryError();
  const { page, limit, sort, status, type, from, to } = parsed.data;
  if (from !== undefined && to !== undefined && from > to) throw new InvalidQueryError();
  return {
    page,
    limit,
    sort,
    ...(status === undefined ? {} : { status }),
    ...(type === undefined ? {} : { type }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}
