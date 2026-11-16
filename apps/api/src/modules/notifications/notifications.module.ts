import { Module } from '@nestjs/common';
import { NotificationsService } from './application/notifications.service';
import { NotificationsController } from './http/notifications.controller';

/** `/notifications` (T6.5): the signed-in user's list, mark one or all as read. API only. */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
