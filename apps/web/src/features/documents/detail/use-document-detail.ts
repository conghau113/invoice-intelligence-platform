'use client';

import { useQuery } from '@tanstack/react-query';
import { DetailError, fetchDocumentDetail, type DocumentDetail } from './detail-client';

export const DETAIL_POLL_MS = 2000;

/** Statuses the worker will still change; once out of them the page has its final data. */
const IN_FLIGHT = new Set(['uploaded', 'queued', 'processing']);

/**
 * Polling is the stop-gap until pushed events (T6.4), like the list. Shorter than the list's 5 s
 * because a person is looking at this one document waiting for its data. TanStack does not poll
 * in a hidden tab.
 */
export function refetchIntervalFor(doc: DocumentDetail | undefined): number | false {
  return doc !== undefined && IN_FLIGHT.has(doc.status) ? DETAIL_POLL_MS : false;
}

export function useDocumentDetail(id: string) {
  return useQuery<DocumentDetail, DetailError>({
    queryKey: ['document', id],
    queryFn: ({ signal }) => fetchDocumentDetail(id, signal),
    refetchInterval: (query) => refetchIntervalFor(query.state.data),
    retry: (count, error) => error.kind === 'error' && count < 1,
  });
}
