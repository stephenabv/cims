import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { NotificationList } from '@cims/shared';
import { Authenticated, CurrentAuth } from '../../common/decorators/auth.decorators';
import type { AuthContext } from '../../common/http/request-context';
import { Clock } from '../../infrastructure/clock/clock';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  @Get()
  @Authenticated()
  list(@CurrentAuth() auth: AuthContext): Promise<NotificationList> {
    return this.notifications.list(auth.userId);
  }

  @Post('read-all')
  @HttpCode(204)
  @Authenticated()
  async readAll(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.notifications.markAllRead(auth.userId, this.clock.now());
  }

  @Post(':id/read')
  @HttpCode(204)
  @Authenticated()
  async read(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<void> {
    await this.notifications.markRead(auth.userId, id, this.clock.now());
  }
}
