import type { NextRequest } from 'next/server';
import { forward } from '@/features/notifications/proxy';
import { bffError } from '@/lib/bff-error';
import { isUuid } from '@/lib/uuid';

/** Marks one notification as read. Same-origin POST only (checked in `forward`). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return bffError('NOT_FOUND', 404);
  return forward(req, `/notifications/${id}/read`, 'POST');
}
