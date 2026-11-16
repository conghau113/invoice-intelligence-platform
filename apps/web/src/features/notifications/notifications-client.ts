import { NotificationPageSchema, type NotificationPage } from 'contracts';

/** How many the bell shows: the newest page. Older ones are still in the database. */
export const BELL_LIMIT = 20;

export class NotificationsError extends Error {
  constructor(readonly status: number) {
    super(`Notifications request failed (${status})`);
    this.name = 'NotificationsError';
  }
}

/** The newest notifications and the unread count, through the BFF (the browser holds no token). */
export async function fetchNotifications(signal?: AbortSignal): Promise<NotificationPage> {
  const res = await fetch(`/api/notifications?limit=${BELL_LIMIT}`, {
    signal,
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new NotificationsError(res.status);
  const parsed = NotificationPageSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new NotificationsError(502);
  return parsed.data;
}

async function post(path: string): Promise<void> {
  const res = await fetch(`/api/notifications${path}`, { method: 'POST', cache: 'no-store' });
  if (!res.ok) throw new NotificationsError(res.status);
}

export const markNotificationRead = (id: string): Promise<void> =>
  post(`/${encodeURIComponent(id)}/read`);

export const markAllNotificationsRead = (): Promise<void> => post('/read-all');

/** The badge text: the count, or "99+" so the badge keeps its size. */
export const badgeText = (unread: number): string => (unread > 99 ? '99+' : String(unread));

/**
 * How often to read again without an event. Connected: events say when, this only catches one that
 * was lost. Not connected (no socket, dropped, realtime off): this is how notifications arrive.
 * TanStack does not poll a hidden tab; coming back to the tab reads again at once.
 */
export const NOTIFICATIONS_POLL_MS = 60_000;
export const NOTIFICATIONS_SAFETY_POLL_MS = 5 * 60_000;
export const notificationsPollMs = (live: boolean): number =>
  live ? NOTIFICATIONS_SAFETY_POLL_MS : NOTIFICATIONS_POLL_MS;
