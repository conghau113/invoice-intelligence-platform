/**
 * Socket.IO rooms (T6.4). A socket joins exactly the rooms of the tenant and user its handshake
 * token names; nothing a client sends can add a room. The user room carries the tenant too: a user
 * who belongs to two tenants and has a socket open in one must not get the other's events there.
 */
export const REALTIME_NAMESPACE = '/realtime';

export const tenantRoom = (tenantId: string): string => `tenant:${tenantId}`;

export const userRoom = (tenantId: string, userId: string): string =>
  `tenant:${tenantId}:user:${userId}`;
