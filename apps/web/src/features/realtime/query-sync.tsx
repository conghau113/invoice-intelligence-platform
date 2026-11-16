'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { DocumentUpdatedEvent } from 'contracts';
import { useEffect, useMemo } from 'react';
import { coalesce } from './coalesce';
import { useDocumentEvents } from './realtime-provider';

/** A burst of events reads the list again once: 300 ms after the last, at least once a second. */
export const LIST_REFRESH_WAIT_MS = 300;
export const LIST_REFRESH_MAX_WAIT_MS = 1_000;

/**
 * What an event does to a screen's queries. Events are hints: the data itself is read again
 * through the BFF and the API (with RLS), never taken from the event. The document's own query at
 * once; the lists coalesced, since 50 uploads make ~150 events.
 */
export function querySync(
  client: Pick<QueryClient, 'invalidateQueries'>,
  timers?: Parameters<typeof coalesce>[3],
) {
  const refreshLists = coalesce(
    () => void client.invalidateQueries({ queryKey: ['documents'] }),
    LIST_REFRESH_WAIT_MS,
    LIST_REFRESH_MAX_WAIT_MS,
    timers,
  );
  return {
    onEvent: (e: DocumentUpdatedEvent) => {
      void client.invalidateQueries({ queryKey: ['document', e.id] });
      refreshLists.call();
    },
    /** After a reconnect events were missed: everything document-related is stale. */
    onResync: () => {
      refreshLists.cancel();
      void client.invalidateQueries({ queryKey: ['document'] });
      void client.invalidateQueries({ queryKey: ['documents'] });
    },
    cancel: refreshLists.cancel,
  };
}

/** Mounted in every QueryProvider (documents list, document detail). Renders nothing. */
export function RealtimeQuerySync() {
  const client = useQueryClient();
  const sync = useMemo(() => querySync(client), [client]);
  useEffect(() => () => sync.cancel(), [sync]);
  useDocumentEvents(sync.onEvent, sync.onResync);
  return null;
}
