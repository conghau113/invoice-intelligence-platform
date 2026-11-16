import type { NextRequest } from 'next/server';
import { forward, notificationsQuery } from '@/features/notifications/proxy';

/** The signed-in user's notifications in the current tenant (T6.5). A read: no origin check needed. */
export async function GET(req: NextRequest) {
  const query = notificationsQuery(req.nextUrl.searchParams);
  return forward(req, `/notifications${query ? `?${query}` : ''}`, 'GET');
}
