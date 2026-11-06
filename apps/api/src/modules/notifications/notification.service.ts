import { Injectable, Logger } from '@nestjs/common';
import type { NotificationList } from '@cims/shared';
import { NotFoundError } from '../../common/errors/app-error';
import { Mailer } from '../../infrastructure/mail/mailer';
import { PrismaService, type PrismaTx } from '../../infrastructure/prisma/prisma.service';

export interface NewNotification {
  userId: string;
  kind: string;
  title: string;
  body: string;
  link?: string | null;
}

const LIST_LIMIT = 30;

/**
 * In-app notifications, with a best-effort email copy. Rows are written in the caller's
 * transaction (so a notice exists only if the change it reports committed); email goes out after
 * the commit via `deliver` and never fails the request.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
  ) {}

  async create(tx: PrismaTx, items: NewNotification[]): Promise<NewNotification[]> {
    if (items.length === 0) return items;
    await tx.notification.createMany({
      data: items.map((n) => ({
        userId: n.userId,
        kind: n.kind,
        title: n.title.slice(0, 200),
        body: n.body.slice(0, 1000),
        link: n.link ?? null,
      })),
    });
    return items;
  }

  /** Emails a copy of committed notifications to each recipient's company address. */
  async deliver(items: NewNotification[]): Promise<void> {
    if (items.length === 0) return;
    const users = await this.prisma.userAccount.findMany({
      where: { id: { in: items.map((i) => i.userId) }, status: 'ACTIVE' },
      select: { id: true, employee: { select: { companyEmail: true } } },
    });
    const email = new Map(users.map((u) => [u.id, u.employee.companyEmail]));
    await Promise.all(
      items.map(async (n) => {
        const to = email.get(n.userId);
        if (!to) return;
        try {
          await this.mailer.send({ to, subject: n.title, text: n.body });
        } catch (err) {
          // The in-app notice is the record; a mail outage must not undo or fail the action.
          this.logger.warn(
            { kind: n.kind, err: (err as Error).message },
            'Notification email failed',
          );
        }
      }),
    );
  }

  async list(userId: string): Promise<NotificationList> {
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      unread,
      data: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
    };
  }

  /** Only the recipient can mark a notice read; anyone else's id is reported as not found. */
  async markRead(userId: string, id: string, now: Date): Promise<void> {
    const res = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { readAt: now },
    });
    if (res.count === 0) throw new NotFoundError('Notification');
  }

  async markAllRead(userId: string, now: Date): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: now },
    });
  }
}
