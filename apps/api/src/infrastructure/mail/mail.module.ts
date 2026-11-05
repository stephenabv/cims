import { Global, Module } from '@nestjs/common';
import { Mailer, SmtpMailer } from './mailer';

@Global()
@Module({ providers: [{ provide: Mailer, useClass: SmtpMailer }], exports: [Mailer] })
export class MailModule {}
