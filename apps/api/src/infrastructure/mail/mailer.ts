import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV, type Env } from '../../common/config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Outbound mail port. Production adapter is SMTP; tests bind an in-memory fake. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

@Injectable()
export class SmtpMailer extends Mailer {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(@Inject(ENV) env: Env) {
    super();
    this.from = env.MAIL_FROM;
    this.transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
    // Log recipient domain only; never the body (it may contain temporary credentials).
    this.logger.log({ toDomain: message.to.split('@')[1], subject: message.subject }, 'Mail sent');
  }
}
