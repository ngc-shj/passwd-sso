/** Email message to be sent via any provider. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** Abstract email provider interface. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
