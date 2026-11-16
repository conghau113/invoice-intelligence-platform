import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { NotificationPage } from 'contracts';
import type { AuthenticatedRequest } from '../../auth/http/authenticated-request';
import { AnyAuthenticated } from '../../auth/http/require-permission.decorator';
import { NotificationsService, type Recipient } from '../application/notifications.service';
import { parseNotificationListQuery } from '../domain/notification-query';

/**
 * API.md "Notifications": the caller's own notifications in the current tenant. Any signed-in user
 * (a viewer uploads nothing, but has an empty list rather than a 403). Rate limit classes are the
 * defaults: GET `read`, POST `write`. The demo's read-only guard refuses the POSTs.
 */
@AnyAuthenticated()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<NotificationPage> {
    return this.notifications.list(recipient(req), parseNotificationListQuery(query));
  }

  /** Declared before `:id/read` only for readability; the paths cannot collide. */
  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  readAll(@Req() req: AuthenticatedRequest): Promise<void> {
    return this.notifications.markAllRead(recipient(req));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  read(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    return this.notifications.markRead(recipient(req), id);
  }
}

function recipient(req: AuthenticatedRequest): Recipient {
  if (!req.user) throw new UnauthorizedException();
  return { tenantId: req.user.tenantId, userId: req.user.userId };
}
