import Bowser from "bowser";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { sendEmail } from "@/lib/email";
import { newDeviceLoginEmail } from "@/lib/email/templates/new-device-login";
import { createNotification } from "@/lib/notification";
import { NOTIFICATION_TYPE } from "@/lib/constants";

interface DeviceMeta {
  ip: string | null;
  userAgent: string | null;
  currentSessionToken?: string;
}

function parseDevice(ua: string): { browserName: string; osName: string } {
  const parsed = Bowser.parse(ua);
  return {
    browserName: parsed.browser.name ?? "Unknown",
    osName: parsed.os.name ?? "Unknown",
  };
}

/**
 * Check if the current login is from a new device.
 * If so, send an email and create an in-app notification.
 *
 * Fire-and-forget: errors are silently caught to never block auth flow.
 */
export async function checkNewDeviceAndNotify(
  userId: string,
  meta: DeviceMeta,
): Promise<void> {
  try {
    if (!meta.userAgent) return;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentSessions = await withBypassRls(prisma, async () =>
      prisma.session.findMany({
        where: {
          userId,
          createdAt: { gte: thirtyDaysAgo },
          // Exclude the session that was just created so it doesn't
          // match itself and incorrectly mark the device as "known".
          ...(meta.currentSessionToken
            ? { sessionToken: { not: meta.currentSessionToken } }
            : {}),
        },
        select: { userAgent: true },
        orderBy: { createdAt: "desc" },
      }),
    );

    // Skip notification for first-ever login (no previous sessions)
    if (recentSessions.length === 0) return;

    const current = parseDevice(meta.userAgent);

    // Check if any recent session has the same browser + OS
    const isKnown = recentSessions.some((s) => {
      if (!s.userAgent) return false;
      const prev = parseDevice(s.userAgent);
      return (
        prev.browserName === current.browserName &&
        prev.osName === current.osName
      );
    });

    if (isKnown) return;

    // New device detected — notify user
    const user = await withBypassRls(prisma, async () =>
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      }),
    );
    if (!user?.email) return;

    const locale = "en";
    const timestamp = new Date().toISOString();

    const emailTemplate = newDeviceLoginEmail(locale, {
      browserName: current.browserName,
      osName: current.osName,
      ipAddress: meta.ip ?? "Unknown",
      timestamp,
    });

    await sendEmail({
      to: user.email,
      subject: emailTemplate.subject,
      html: emailTemplate.html,
      text: emailTemplate.text,
    });

    void createNotification({
      userId,
      type: NOTIFICATION_TYPE.NEW_DEVICE_LOGIN,
      title: locale.startsWith("ja")
        ? "新しいデバイスからのログイン"
        : "New device login",
      body: locale.startsWith("ja")
        ? `${current.browserName} (${current.osName}) からログインしました`
        : `Signed in from ${current.browserName} (${current.osName})`,
      metadata: {
        browserName: current.browserName,
        osName: current.osName,
        ipAddress: meta.ip,
        timestamp,
      },
    });
  } catch {
    // Fire-and-forget: never block auth flow
  }
}
