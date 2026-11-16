'use client';

import { useQuery } from '@tanstack/react-query';
import { useRealtimeStatus } from '@/features/realtime/realtime-provider';
import { SAFETY_POLL_MS } from '../use-document-list';
import { DetailError, fetchDocumentDetail, type DocumentDetail } from './detail-client';

export const DETAIL_POLL_MS = 2000;

/** Statuses the worker will still change; once out of them the page has its final data. */
const IN_FLIGHT = new Set(['uploaded', 'queued', 'processing']);

/**
 * Like the list: with the realtime socket up, an event refreshes this document and a slow poll only
 * catches a lost one; otherwise poll every 2 s, shorter than the list's 5 s because a person is
 * looking at this one document waiting for its data. TanStack does not poll in a hidden tab.
 */
export function refetchIntervalFor(doc: DocumentDetail | undefined, live = false): number | false {
  if (doc === undefined || !IN_FLIGHT.has(doc.status)) return false;
  return live ? SAFETY_POLL_MS : DETAIL_POLL_MS;
}

export function useDocumentDetail(id: string) {
  const live = useRealtimeStatus() === 'connected';
  return useQuery<DocumentDetail, DetailError>({
    queryKey: ['document', id],
    queryFn: ({ signal }) => fetchDocumentDetail(id, signal),
    refetchInterval: (query) => refetchIntervalFor(query.state.data, live),
    retry: (count, error) => error.kind === 'error' && count < 1,
  });
}
