import { DOCUMENT_STATUSES, type DocumentStatus } from '@/components/common/status-badge';

// Mirrors apps/api documents/domain/document-list-query.ts. The API is the authority (it answers
// 400 to anything else); this copy keeps a bad URL from ever reaching it.
export const SOURCE_TYPES = ['xml', 'pdf', 'image'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SORTS = ['-createdAt', 'createdAt'] as const;
export type Sort = (typeof SORTS)[number];

export const PAGE_SIZES = [10, 20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 20;
/** Same ceiling as the API (a page beyond it is a 400). */
export const MAX_PAGE = 10_000;

export interface ListParams {
  status?: DocumentStatus;
  type?: SourceType;
  /** Inclusive days, YYYY-MM-DD (Asia/Ho_Chi_Minh). */
  from?: string;
  to?: string;
  sort: Sort;
  /** 1-based. */
  page: number;
  pageSize: PageSize;
}

const oneOf = <T extends string>(allowed: readonly T[], v: string | null): T | undefined =>
  allowed.find((a) => a === v);

function day(v: string | null): string | undefined {
  if (v === null || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : undefined;
}

/** A whole number in range, else undefined ("3" yes; "3.5", "-1", "abc", "" no). */
function whole(v: string | null, max: number): number | undefined {
  if (v === null || !/^\d{1,6}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= max ? n : undefined;
}

/** Reads the URL. Anything unknown or malformed is dropped, so a hand-edited link still renders. */
export function parseListParams(search: { get(name: string): string | null }): ListParams {
  const size = whole(search.get('pageSize'), 100);
  const params: ListParams = {
    sort: oneOf(SORTS, search.get('sort')) ?? '-createdAt',
    page: whole(search.get('page'), MAX_PAGE) ?? 1,
    pageSize: PAGE_SIZES.find((p) => p === size) ?? DEFAULT_PAGE_SIZE,
  };
  const status = oneOf(DOCUMENT_STATUSES, search.get('status'));
  const type = oneOf(SOURCE_TYPES, search.get('type'));
  const from = day(search.get('from'));
  const to = day(search.get('to'));
  if (status) params.status = status;
  if (type) params.type = type;
  if (from) params.from = from;
  // A reversed range would be a 400; ignoring the end keeps the page usable.
  if (to && !(from && from > to)) params.to = to;
  return params;
}

/** Query for the URL: defaults are left out so a shared link stays short. */
export function toQuery(p: ListParams): Record<string, string> {
  const q: Record<string, string> = {};
  if (p.status) q.status = p.status;
  if (p.type) q.type = p.type;
  if (p.from) q.from = p.from;
  if (p.to) q.to = p.to;
  if (p.sort !== '-createdAt') q.sort = p.sort;
  if (p.page !== 1) q.page = String(p.page);
  if (p.pageSize !== DEFAULT_PAGE_SIZE) q.pageSize = String(p.pageSize);
  return q;
}

/** Query for GET /api/documents: the URL's, always with the page size spelled out as `limit`. */
export function toApiQuery(p: ListParams): string {
  const query: Record<string, string> = { ...toQuery(p), limit: String(p.pageSize) };
  delete query.pageSize;
  return new URLSearchParams(query).toString();
}

export const hasFilters = (p: ListParams): boolean =>
  p.status !== undefined || p.type !== undefined || p.from !== undefined || p.to !== undefined;
