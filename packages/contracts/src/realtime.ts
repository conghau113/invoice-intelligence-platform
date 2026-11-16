import { z } from 'zod';

/**
 * Realtime events (T6.4, ADR 0014, API.md "Realtime"). Pushed by the API's Socket.IO gateway; the
 * web treats every event as a hint and reads the data again through REST, because an event can be
 * missed (a dropped connection, a failed publish). Ids and statuses only: never document content.
 */

/** Socket.IO path of the gateway (the default `/socket.io` would collide with nothing, but a name says what it is). */
export const REALTIME_PATH = '/realtime/socket.io';

/** A document changed status. Sent to the tenant's room after the change has committed. */
export const DOCUMENT_UPDATED = 'document.updated';

export const DocumentUpdatedEventSchema = z.strictObject({
  id: z.uuid(),
  /** A document status (ARCHITECTURE.md section 8); a status the web does not know is shown as is. */
  status: z.string().regex(/^[a-z_]{1,32}$/),
  version: z.int().min(1),
});
export type DocumentUpdatedEvent = z.infer<typeof DocumentUpdatedEventSchema>;

/** What `POST /realtime/token` answers: a token that only the gateway accepts, for one handshake. */
export const RealtimeTokenSchema = z.strictObject({
  token: z.string().min(1).max(2048),
  /** Seconds until the token expires. */
  expiresIn: z.int().min(1),
});
export type RealtimeToken = z.infer<typeof RealtimeTokenSchema>;
