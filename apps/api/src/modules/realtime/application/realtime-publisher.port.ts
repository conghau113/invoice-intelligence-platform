import type {
  DOCUMENT_UPDATED,
  DocumentUpdatedEvent,
  NOTIFICATION_CREATED,
  NotificationCreatedEvent,
} from 'contracts';

/** Every event the server pushes, with its payload (API.md "Realtime"). */
export type RealtimeEvent =
  | { name: typeof DOCUMENT_UPDATED; payload: DocumentUpdatedEvent }
  | { name: typeof NOTIFICATION_CREATED; payload: NotificationCreatedEvent };

/**
 * "Tell the browsers": used by the API and by the worker, which is a separate process with no
 * sockets of its own (ADR 0008). Call after COMMIT (TenantDbService.afterCommit), so a client that
 * reads on the event sees the new data. Fire and forget: never throws, never waits on Redis. An
 * event that is lost is caught up by the client's own reads (reconnect, slow poll).
 */
export interface RealtimePublisher {
  toTenant(tenantId: string, event: RealtimeEvent): void;
  toUser(tenantId: string, userId: string, event: RealtimeEvent): void;
}
export const REALTIME_PUBLISHER = Symbol('REALTIME_PUBLISHER');

/** For code built by hand without realtime (tests that test something else). */
export const NO_REALTIME: RealtimePublisher = {
  toTenant: () => undefined,
  toUser: () => undefined,
};
