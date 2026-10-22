'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchDocuments, ListError, type DocumentPage } from './list-client';
import type { ListParams } from './list-params';

export const POLL_MS = 5000;

/** Statuses a document leaves on its own, so the list is worth re-reading while one is on screen. */
const IN_FLIGHT = new Set(['uploaded', 'queued', 'processing']);

/**
 * The one place that decides how the list stays fresh. Polling is the stop-gap; T6.4 replaces it
 * with pushed events and only this function and the `refetchInterval` line below go away.
 * TanStack does not poll in a hidden tab (refetchIntervalInBackground defaults to false).
 */
export function refetchIntervalFor(page: DocumentPage | undefined): number | false {
  return page?.items.some((d) => IN_FLIGHT.has(d.status)) ? POLL_MS : false;
}

export function useDocumentList(params: ListParams) {
  return useQuery<DocumentPage, ListError>({
    queryKey: ['documents', params],
    queryFn: ({ signal }) => fetchDocuments(params, signal),
    refetchInterval: (query) => refetchIntervalFor(query.state.data),
    placeholderData: keepPreviousData, // keep the old rows on screen while the next page loads
    // A refused or unreachable list will not fix itself by being asked three times in a row.
    retry: (count, error) => error.kind === 'error' && count < 1,
  });
}
