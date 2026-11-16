'use client';

import type { DocumentUpdatedEvent } from 'contracts';
import { REALTIME_PATH } from 'contracts';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { io } from 'socket.io-client';
import { RealtimeConnection, type RealtimeStatus, type SocketLike } from './connection';
import { fetchRealtimeToken } from './token-client';

const RealtimeContext = createContext<RealtimeConnection | null>(null);

function browserConnection(): RealtimeConnection {
  return new RealtimeConnection({
    fetchToken: () => fetchRealtimeToken(),
    createSocket: (url, auth) =>
      io(`${url}/realtime`, {
        path: REALTIME_PATH,
        // WebSocket only: no sticky sessions needed in front of several API instances.
        transports: ['websocket'],
        auth,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 30_000,
      }) as unknown as SocketLike, // socket.io's overloads are wider than SocketLike's
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    random: Math.random,
    now: Date.now,
  });
}

/**
 * One socket per tab for the signed-in pages (mounted by the app layout). The object is created in
 * the browser only; the socket opens in an effect, so the server render has none and hydration sees
 * the server's `off` status (useSyncExternalStore's server snapshot). Screens poll until connected.
 */
export function RealtimeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [connection] = useState<RealtimeConnection | null>(() =>
    typeof window === 'undefined' ? null : browserConnection(),
  );
  useEffect(() => {
    if (connection === null) return;
    void connection.start();
    return () => connection.stop();
  }, [connection]);
  return <RealtimeContext.Provider value={connection}>{children}</RealtimeContext.Provider>;
}

const OFF = (): RealtimeStatus => 'off';
const NOOP_SUBSCRIBE = () => () => undefined;

/** `off` outside the provider (tests, pages without realtime): screens then poll as before. */
export function useRealtimeStatus(): RealtimeStatus {
  const c = useContext(RealtimeContext);
  return useSyncExternalStore(c?.subscribeStatus ?? NOOP_SUBSCRIBE, c?.getStatus ?? OFF, OFF);
}

/** Runs `listener` for every document event, and `onResync` after a reconnect (events were missed). */
export function useDocumentEvents(
  listener: (e: DocumentUpdatedEvent) => void,
  onResync?: () => void,
): void {
  const c = useContext(RealtimeContext);
  // Latest callbacks without resubscribing on every render.
  const latest = useRef({ listener, onResync });
  useEffect(() => {
    latest.current = { listener, onResync };
  });
  useEffect(() => {
    if (c === null) return;
    const offEvent = c.onEvent((e) => latest.current.listener(e));
    const offResync = c.onResync(() => latest.current.onResync?.());
    return () => {
      offEvent();
      offResync();
    };
  }, [c]);
}
