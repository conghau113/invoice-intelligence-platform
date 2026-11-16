import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  badgeText,
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NotificationsError,
  notificationsPollMs,
} from './notifications-client';

const PAGE = {
  items: [],
  meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
  unreadCount: 0,
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('notifications client', () => {
  it('reads the newest page through the BFF', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(PAGE));
    expect(await fetchNotifications()).toEqual(PAGE);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/notifications?limit=20');
  });

  it('throws on an error status or an answer outside the contract', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'RATE_LIMITED' }, { status: 429 }));
    await expect(fetchNotifications()).rejects.toEqual(new NotificationsError(429));
    fetchMock.mockResolvedValueOnce(Response.json({ ...PAGE, unreadCount: -1 }));
    await expect(fetchNotifications()).rejects.toEqual(new NotificationsError(502));
  });

  it('marks one or all as read with a POST', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await markNotificationRead('abc');
    await markAllNotificationsRead();
    expect(fetchMock.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method])).toEqual([
      ['/api/notifications/abc/read', 'POST'],
      ['/api/notifications/read-all', 'POST'],
    ]);
  });

  it('throws when marking fails (the demo refuses writes)', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ code: 'DEMO_READ_ONLY' }, { status: 403 }));
    await expect(markAllNotificationsRead()).rejects.toEqual(new NotificationsError(403));
  });

  it('polls every minute without a socket, every five with one', () => {
    expect(notificationsPollMs(false)).toBe(60_000);
    expect(notificationsPollMs(true)).toBe(300_000);
  });

  it('caps the badge text', () => {
    expect([badgeText(1), badgeText(99), badgeText(100)]).toEqual(['1', '99', '99+']);
  });
});
