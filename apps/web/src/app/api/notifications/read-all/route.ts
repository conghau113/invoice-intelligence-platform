import type { NextRequest } from 'next/server';
import { forward } from '@/features/notifications/proxy';

/** Marks every notification of the user in the current tenant as read. Same-origin POST only. */
export async function POST(req: NextRequest) {
  return forward(req, '/notifications/read-all', 'POST');
}
