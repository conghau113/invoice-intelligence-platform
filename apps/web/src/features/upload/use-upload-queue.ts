'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { fetchDocumentDetail } from '@/features/documents/detail/detail-client';
import { useDocumentEvents } from '@/features/realtime/realtime-provider';
import { UploadQueue } from './upload-queue';
import { createXhrTransport } from './xhr-transport';

export function useUploadQueue() {
  // One queue per mounted screen; leaving the page cancels what is running (background upload is out of scope).
  const queue = useMemo(() => new UploadQueue(createXhrTransport()), []);
  useEffect(() => () => queue.cancelAll(), [queue]);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  // Each uploaded file's status follows the worker (T6.4). After a reconnect the events in between
  // are lost, so the files still in flight are read again. Without realtime a row stays at the
  // status the upload answered with; the documents list is where the rest shows (it polls).
  useDocumentEvents(
    (e) => queue.applyDocumentStatus(e.id, e.status, e.version),
    () => {
      for (const id of queue.inFlightDocumentIds()) {
        fetchDocumentDetail(id).then(
          (d) => queue.applyDocumentStatus(id, d.status, d.version),
          () => undefined, // the next event or the documents list will tell
        );
      }
    },
  );
  return { queue, items };
}
