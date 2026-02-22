import nodemailer from "nodemailer";
import type { EmailMessage, EmailProvider } from "./types";

export class SmtpProvider implements EmailProvider {
  private transporter: nodemailer.Transporter;
  private from: string;

  constructor(options: {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    from: string;
  }) {
    this.from = options.from;
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      ...(options.user && options.pass
        ? { auth: { user: options.user, pass: options.pass } }
        : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}
