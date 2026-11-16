import {
  DOCUMENT_UPDATED,
  DocumentUpdatedEventSchema,
  NOTIFICATION_CREATED,
  NotificationCreatedEventSchema,
  type DocumentUpdatedEvent,
  type NotificationCreatedEvent,
} from 'contracts';
import type { TokenResult } from './token-client';

/**
 * - `connecting`: not connected yet (first attempt). The screens poll as before.
 * - `connected`: events arrive; the screens only poll slowly, as a safety net.
 * - `disconnected`: lost, reconnecting; the screens poll as before (the fallback of the spec).
 * - `off`: realtime is not available here (not configured, read-only demo, signed out). Poll.
 */
export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected' | 'off';

/** The part of a socket.io-client Socket this uses, so tests can drive a fake one. */
export interface SocketLike {
  /** True while the client itself will retry (a dropped connection); false after a refused handshake. */
  readonly active: boolean;
  on(event: 'connect', fn: () => void): unknown;
  on(event: 'disconnect', fn: (reason: string) => void): unknown;
  on(event: 'connect_error', fn: (err: Error) => void): unknown;
  on(event: typeof DOCUMENT_UPDATED, fn: (payload: unknown) => void): unknown;
  on(event: typeof NOTIFICATION_CREATED, fn: (payload: unknown) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
}

/** Called by the socket before every connection attempt for the handshake data. */
export type AuthCallback = (cb: (data: { token?: string }) => void) => void;

export interface ConnectionDeps {
  fetchToken: () => Promise<TokenResult>;
  createSocket: (url: string, auth: AuthCallback) => SocketLike;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  random: () => number;
  now: () => number;
}

/** A refused handshake is retried after 2 s, 4 s, ... up to a minute, each cut by up to half. */
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** A socket the server closed sooner than this after it opened is treated as a refusal (back off). */
const MIN_HEALTHY_MS = 5_000;
/** `off` because of a 404/403 is checked again this often: a deploy may have switched realtime on. */
const OFF_RECHECK_MS = 5 * 60_000;

/**
 * One realtime connection per tab (T6.4). Framework-free so tests can drive it.
 *
 * The socket's own reconnection handles a dropped connection (exponential backoff with jitter).
 * Two cases it does not retry, handled here: a refused handshake (expired token, API restarted
 * with another key) and the server closing the socket at its maximum age. Before every attempt the
 * token is fetched again from the web server, so a signed-out person stops getting events.
 *
 * Events are hints (API.md): listeners read the data again through REST. After a reconnect the
 * `resync` listeners run, since events sent while disconnected are lost.
 */
export class RealtimeConnection {
  private status: RealtimeStatus = 'connecting';
  private socket: SocketLike | null = null;
  private stopped = false;
  /** Bumped by start and stop: work of an earlier start that finishes late is dropped. */
  private generation = 0;
  private everConnected = false;
  private connectedAt = 0;
  private failures = 0;
  private retryTimer: unknown = null;
  /** A token fetched by the retry check, used by the next handshake instead of fetching again. */
  private nextToken: string | null = null;
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: DocumentUpdatedEvent) => void>();
  private readonly notificationListeners = new Set<(e: NotificationCreatedEvent) => void>();
  private readonly resyncListeners = new Set<() => void>();

  constructor(private readonly deps: ConnectionDeps) {}

  getStatus = (): RealtimeStatus => this.status;

  subscribeStatus = (fn: () => void): (() => void) => {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  };

  onEvent(fn: (e: DocumentUpdatedEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** A notification was stored for this user (T6.5). Sent to the user's room only. */
  onNotification(fn: (e: NotificationCreatedEvent) => void): () => void {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  onResync(fn: () => void): () => void {
    this.resyncListeners.add(fn);
    return () => this.resyncListeners.delete(fn);
  }

  /** Safe to call again after stop (React runs effects twice in development). */
  async start(): Promise<void> {
    const generation = ++this.generation;
    this.stopped = false;
    const first = await this.deps.fetchToken();
    if (this.stopped || generation !== this.generation) return;
    if (first.kind === 'off' || first.kind === 'signed-out') return this.turnOff(first.kind);
    if (first.kind === 'error') {
      this.setStatus('disconnected');
      return this.scheduleRetry(() => void this.start());
    }
    this.nextToken = first.token;
    this.open(first.url);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  private open(url: string): void {
    // Every callback below belongs to this start: after stop (and maybe a new start) it does nothing,
    // so an old socket can never be brought back to life next to the new one.
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    const socket = this.deps.createSocket(url, (cb) => {
      const ready = this.nextToken;
      this.nextToken = null;
      if (ready !== null) return cb({ token: ready });
      void this.deps.fetchToken().then((r) => {
        if (!current()) return cb({});
        if (r.kind === 'off' || r.kind === 'signed-out') this.turnOff(r.kind);
        cb(r.kind === 'ok' ? { token: r.token } : {});
      });
    });
    this.socket = socket;

    socket.on('connect', () => {
      if (!current()) return;
      this.connectedAt = this.deps.now();
      const again = this.everConnected;
      this.everConnected = true;
      this.setStatus('connected');
      if (again) for (const fn of this.resyncListeners) fn();
    });
    socket.on('disconnect', (reason) => {
      if (!current()) return;
      this.setStatus('disconnected');
      const healthy = this.deps.now() - this.connectedAt >= MIN_HEALTHY_MS;
      if (healthy) this.failures = 0; // backoff counts refusals in a row, not over the tab's life
      // The server closed it on purpose: the client does not retry that by itself. After a healthy
      // life (maximum age) reconnect at once; closed right after opening, back off like a refusal.
      if (reason !== 'io server disconnect') return;
      if (healthy) {
        socket.connect();
      } else {
        this.retryWithFreshToken(socket, current);
      }
    });
    socket.on('connect_error', () => {
      if (!current() || socket.active) return; // a dropped connection: the socket retries itself
      this.setStatus('disconnected');
      this.retryWithFreshToken(socket, current);
    });
    socket.on(DOCUMENT_UPDATED, (payload) => {
      if (!current()) return;
      const parsed = DocumentUpdatedEventSchema.safeParse(payload);
      if (!parsed.success) return; // not something this version understands: ignore it
      for (const fn of this.eventListeners) fn(parsed.data);
    });
    socket.on(NOTIFICATION_CREATED, (payload) => {
      if (!current()) return;
      const parsed = NotificationCreatedEventSchema.safeParse(payload);
      if (!parsed.success) return;
      for (const fn of this.notificationListeners) fn(parsed.data);
    });
  }

  /** Refused handshake. Ask for a token first: the answer may be that realtime is now off. */
  private retryWithFreshToken(socket: SocketLike, current: () => boolean): void {
    this.scheduleRetry(() => {
      void this.deps.fetchToken().then((r) => {
        if (!current()) return;
        if (r.kind === 'off' || r.kind === 'signed-out') return this.turnOff(r.kind);
        this.nextToken = r.kind === 'ok' ? r.token : null;
        socket.connect();
      });
    });
  }

  private scheduleRetry(fn: () => void): void {
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.failures);
    this.failures += 1;
    const delay = ceiling / 2 + this.deps.random() * (ceiling / 2);
    if (this.retryTimer !== null) this.deps.clearTimer(this.retryTimer);
    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;
      if (!this.stopped) fn();
    }, delay);
  }

  /**
   * Signed out: stop for good (the next sign-in loads the app again). Off (404/403, e.g. a deploy
   * that has realtime switched off for a moment): check again every few minutes.
   */
  private turnOff(kind: 'off' | 'signed-out'): void {
    this.stop();
    this.setStatus('off');
    if (kind === 'off') {
      const generation = this.generation;
      this.retryTimer = this.deps.setTimer(() => {
        this.retryTimer = null;
        if (generation === this.generation) void this.start();
      }, OFF_RECHECK_MS);
    }
  }

  private setStatus(next: RealtimeStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const fn of this.statusListeners) fn();
  }
}
