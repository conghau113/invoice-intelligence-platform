'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { RealtimeQuerySync } from '@/features/realtime/query-sync';

/**
 * One client per mounted tree; a module-level client would share cached rows between users on the
 * server. Realtime events (T6.4) mark this tree's document queries stale, so they are read again.
 */
export function QueryProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <RealtimeQuerySync />
      {children}
    </QueryClientProvider>
  );
}
