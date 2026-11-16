'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchDocuments, ListError, type DocumentPage } from './list-client';
import type { ListParams } from './list-params';
import { useRealtimeStatus } from '@/features/realtime/realtime-provider';

export const POLL_MS = 5000;
/** While the realtime socket is up, events refresh the list; this slow poll only catches a lost one. */
export const SAFETY_POLL_MS = 30_000;

/** Statuses a document leaves on its own, so the list is worth re-reading while one is on screen. */
const IN_FLIGHT = new Set(['uploaded', 'queued', 'processing']);

/**
 * The one place that decides how the list stays fresh while a document on screen is in flight.
 * Realtime connected (T6.4): pushed events refresh the list (RealtimeQuerySync), and a slow poll
 * only catches an event that was lost. Not connected (no socket yet, dropped, or realtime off):
 * poll every 5 s as before, which is the fallback. TanStack does not poll in a hidden tab
 * (refetchIntervalInBackground defaults to false).
 */
export function refetchIntervalFor(page: DocumentPage | undefined, live = false): number | false {
  if (!page?.items.some((d) => IN_FLIGHT.has(d.status))) return false;
  return live ? SAFETY_POLL_MS : POLL_MS;
}

export function useDocumentList(params: ListParams) {
  const live = useRealtimeStatus() === 'connected';
  return useQuery<DocumentPage, ListError>({
    queryKey: ['documents', params],
    queryFn: ({ signal }) => fetchDocuments(params, signal),
    refetchInterval: (query) => refetchIntervalFor(query.state.data, live),
    placeholderData: keepPreviousData, // keep the old rows on screen while the next page loads
    // A refused or unreachable list will not fix itself by being asked three times in a row.
    retry: (count, error) => error.kind === 'error' && count < 1,
  });
}
