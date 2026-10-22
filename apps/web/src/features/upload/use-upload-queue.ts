'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { UploadQueue } from './upload-queue';
import { createXhrTransport } from './xhr-transport';

export function useUploadQueue() {
  // One queue per mounted screen; leaving the page cancels what is running (background upload is out of scope).
  const queue = useMemo(() => new UploadQueue(createXhrTransport()), []);
  useEffect(() => () => queue.cancelAll(), [queue]);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return { queue, items };
}
