import { getLogger } from "@/lib/logger";
import { ResendProvider } from "./resend-provider";
import { SmtpProvider } from "./smtp-provider";
import type { EmailMessage, EmailProvider } from "./types";

let provider: EmailProvider | null = null;
let initialised = false;

function initProvider(): EmailProvider | null {
  if (initialised) return provider;
  initialised = true;

  const type = process.env.EMAIL_PROVIDER;
  const from = process.env.EMAIL_FROM || "noreply@localhost";

  if (type === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      getLogger().warn("EMAIL_PROVIDER=resend but RESEND_API_KEY is not set");
      return null;
    }
    provider = new ResendProvider(apiKey, from);
  } else if (type === "smtp") {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
    if (!host) {
      getLogger().warn("EMAIL_PROVIDER=smtp but SMTP_HOST is not set");
      return null;
    }
    provider = new SmtpProvider({
      host,
      port,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from,
    });
  } else if (type) {
    getLogger().warn({ provider: type }, "Unknown EMAIL_PROVIDER value");
  }

  return provider;
}

/**
 * Send an email using the configured provider.
 * Async nonblocking: errors are logged but never thrown.
 * If EMAIL_PROVIDER is not set, the call is silently skipped.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const p = initProvider();
  if (!p) return;

  try {
    await p.send(message);
  } catch (err) {
    getLogger().error(
      { to: message.to, subject: message.subject, err },
      "email.send.failed",
    );
  }
}

/** Reset internal state — for testing only. */
export function _resetForTesting(): void {
  provider = null;
  initialised = false;
}
