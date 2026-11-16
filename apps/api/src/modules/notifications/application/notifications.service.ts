import { Injectable, NotFoundException } from '@nestjs/common';
import type { Notification, NotificationPage } from 'contracts';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { notifications } from '../../../db/schema';
import { TenantDbService, type Db, type Tx } from '../../../db/tenant-db.service';
import type { NotificationListQuery } from '../domain/notification-query';

export interface Recipient {
  tenantId: string;
  userId: string;
}

/**
 * The user's own notifications. RLS limits every statement to the tenant; the user filter is
 * here, in `mine`, which every statement goes through (tenant-isolation tests cover both). Runs in
 * the request's tenant transaction. Not cached: per user, small, and read mostly after an event.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async list(who: Recipient, q: NotificationListQuery): Promise<NotificationPage> {
    const tx = this.tenantDb.current();
    const items = await this.page(tx, who, q);
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        unread: sql<number>`(count(*) filter (where ${notifications.readAt} is null))::int`,
      })
      .from(notifications)
      .where(and(...this.mine(who)));
    const total = counts?.total ?? 0;
    return {
      items: items.map(toNotification),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
      unreadCount: counts?.unread ?? 0,
    };
  }

  /**
   * Idempotent: reading a read notification keeps its first `read_at`. Someone else's id, in this
   * tenant or another, is 404 like an id that does not exist.
   */
  async markRead(who: Recipient, id: string): Promise<void> {
    const tx = this.tenantDb.current();
    const [row] = await tx
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(and(...this.mine(who), eq(notifications.id, id)))
      .for('update');
    if (!row) throw new NotFoundException('Notification not found');
    if (row.readAt !== null) return;
    await tx
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(...this.mine(who), eq(notifications.id, id)));
  }

  async markAllRead(who: Recipient): Promise<void> {
    await this.tenantDb
      .current()
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(...this.mine(who), isNull(notifications.readAt)));
  }

  /** Newest first. NULLS LAST spelled out to match the index (see DocumentsListService.build). */
  page(tx: Db | Tx, who: Recipient, q: NotificationListQuery) {
    return tx
      .select({
        id: notifications.id,
        kind: notifications.kind,
        documentId: notifications.documentId,
        failureCode: notifications.failureCode,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .where(and(...this.mine(who)))
      .orderBy(
        sql`${notifications.createdAt} DESC NULLS LAST`,
        sql`${notifications.id} DESC NULLS LAST`,
      )
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);
  }

  /** The tenant is repeated next to RLS so the planner can use it as an index condition. */
  private mine(who: Recipient): SQL[] {
    return [eq(notifications.tenantId, who.tenantId), eq(notifications.userId, who.userId)];
  }
}

type Row = Awaited<ReturnType<NotificationsService['page']>>[number];

function toNotification(r: Row): Notification {
  return {
    id: r.id,
    // The CHECK constraints hold these to the contract's values; the type cannot know that.
    kind: r.kind as Notification['kind'],
    documentId: r.documentId,
    failureCode: r.failureCode as Notification['failureCode'],
    createdAt: r.createdAt.toISOString(),
    readAt: r.readAt?.toISOString() ?? null,
  };
}
