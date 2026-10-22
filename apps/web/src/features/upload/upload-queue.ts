import type { DocumentStatus } from '@/components/common/status-badge';
import { errorKeyFor, isRetryable, type UploadErrorKey, type UploadFailure } from './error-keys';
import { validateFile } from './validate';

/** At most this many requests in flight: more only competes for the same bandwidth and the API's connection pool. */
export const MAX_CONCURRENT_UPLOADS = 3;

export type UploadState = 'pending' | 'uploading' | 'done' | 'duplicate' | 'error' | 'cancelled';

export interface UploadedDocument {
  id: string;
  status: DocumentStatus;
}

export type TransportResult =
  | { kind: 'ok'; created: boolean; document: UploadedDocument }
  | { kind: 'error'; failure: UploadFailure }
  | { kind: 'aborted' };

export interface UploadRequest {
  result: Promise<TransportResult>;
  abort: () => void;
}

/** The only part that touches the network; the queue is tested with a fake one. */
export interface UploadTransport {
  send: (
    file: File,
    idempotencyKey: string,
    onProgress: (loaded: number, total: number) => void,
  ) => UploadRequest;
}

export interface UploadItem {
  id: string;
  file: File;
  /** One per chosen file, kept across retries so a request the server already accepted replays instead of duplicating. */
  idempotencyKey: string;
  state: UploadState;
  /** 0-100, only ever goes up within one attempt. */
  progress: number;
  errorKey?: UploadErrorKey;
  retryable: boolean;
  document?: UploadedDocument;
}

/** crypto.randomUUID needs a secure context; plain http on a LAN host would otherwise break uploads. */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Client-side upload queue: validates, runs at most `concurrency` uploads at once, reports
 * progress, and lets each file be cancelled or retried on its own. One file failing only changes
 * that file's state; the rest keep going. Framework-free so it can be driven from tests and read
 * from React with useSyncExternalStore.
 */
export class UploadQueue {
  private items: readonly UploadItem[] = [];
  private readonly inFlight = new Map<string, { attempt: number; abort: () => void }>();
  private readonly listeners = new Set<() => void>();
  private attempts = 0;

  constructor(
    private readonly transport: UploadTransport,
    private readonly concurrency = MAX_CONCURRENT_UPLOADS,
    private readonly newId: () => string = randomUuid,
  ) {}

  /** Stable between changes, as useSyncExternalStore requires. */
  getSnapshot = (): readonly UploadItem[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  add(files: readonly File[]): void {
    const added = files.map((file): UploadItem => {
      const problem = validateFile(file);
      return {
        id: this.newId(),
        file,
        idempotencyKey: this.newId(),
        state: problem ? 'error' : 'pending',
        progress: 0,
        errorKey: problem ?? undefined,
        retryable: false,
      };
    });
    this.items = [...this.items, ...added];
    this.emit();
    this.pump();
  }

  cancel(id: string): void {
    const item = this.find(id);
    if (!item || (item.state !== 'pending' && item.state !== 'uploading')) return;
    // Free the slot now; the aborted request's late result is ignored by the attempt check.
    this.inFlight.get(id)?.abort();
    this.inFlight.delete(id);
    this.patch(id, { state: 'cancelled', progress: 0 });
    this.pump();
  }

  retry(id: string): void {
    const item = this.find(id);
    if (!item) return;
    const canRetry = item.state === 'cancelled' || (item.state === 'error' && item.retryable);
    if (!canRetry) return;
    this.patch(id, { state: 'pending', progress: 0, errorKey: undefined, retryable: false });
    this.pump();
  }

  /** Page left: stop what is running and never start what is waiting (nothing would show the result). */
  cancelAll(): void {
    // Waiting files first: cancelling a running one frees a slot and would start the next waiting one.
    const byState = (state: UploadState) => this.items.filter((i) => i.state === state);
    for (const i of [...byState('pending'), ...byState('uploading')]) this.cancel(i.id);
  }

  /** Drops finished rows (done, duplicate, cancelled, rejected-before-sending) from the list. */
  clearSettled(): void {
    this.items = this.items.filter(
      (i) =>
        i.state === 'pending' || i.state === 'uploading' || (i.state === 'error' && i.retryable),
    );
    this.emit();
  }

  private find(id: string): UploadItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  private patch(id: string, change: Partial<UploadItem>): void {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...change } : i));
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private pump(): void {
    while (this.inFlight.size < this.concurrency) {
      const next = this.items.find((i) => i.state === 'pending');
      if (!next) return;
      this.start(next);
    }
  }

  private start(item: UploadItem): void {
    const attempt = ++this.attempts;
    const current = () => this.inFlight.get(item.id)?.attempt === attempt;
    this.patch(item.id, { state: 'uploading', progress: 0 });
    let request: UploadRequest;
    try {
      request = this.transport.send(item.file, item.idempotencyKey, (loaded, total) => {
        if (!current() || total <= 0) return;
        const pct = Math.min(100, Math.floor((loaded / total) * 100));
        if (pct > (this.find(item.id)?.progress ?? 0)) this.patch(item.id, { progress: pct });
      });
    } catch {
      this.settle(item.id, { kind: 'error', failure: {} });
      return;
    }
    this.inFlight.set(item.id, { attempt, abort: request.abort });
    request.result.then(
      (r) => current() && this.settle(item.id, r),
      () => current() && this.settle(item.id, { kind: 'error', failure: {} }),
    );
  }

  private settle(id: string, result: TransportResult): void {
    this.inFlight.delete(id);
    if (result.kind === 'ok') {
      this.patch(id, {
        state: result.created ? 'done' : 'duplicate',
        progress: 100,
        document: result.document,
      });
    } else if (result.kind === 'aborted') {
      this.patch(id, { state: 'cancelled', progress: 0 });
    } else {
      const errorKey = errorKeyFor(result.failure);
      this.patch(id, { state: 'error', errorKey, retryable: isRetryable(errorKey) });
    }
    this.pump();
  }
}
