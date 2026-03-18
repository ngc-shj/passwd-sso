/**
 * Notify tenant admins when a vault lockout is triggered.
 *
 * Fire-and-forget: errors are caught and logged, never blocking the auth flow.
 * Follows the same pattern as new-device-detection.ts.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { sendEmail } from "@/lib/email";
import { vaultLockoutEmail } from "@/lib/email/templates/vault-lockout";
import { createNotification } from "@/lib/notification";
import { NOTIFICATION_TYPE, TENANT_ROLE } from "@/lib/constants";
import { notificationTitle, notificationBody } from "@/lib/notification-messages";
import { resolveUserLocale } from "@/lib/locale";
import { getLogger } from "@/lib/logger";

export interface LockoutNotifyParams {
  userId: string;
  attempts: number;
  lockMinutes: number;
  ip: string | null;
}

/**
 * Send in-app notification + email to all OWNER and ADMIN users of the
 * affected user's tenant.
 *
 * Fire-and-forget: the outer catch ensures this never throws.
 */
export async function notifyAdminsOfLockout(
  params: LockoutNotifyParams,
): Promise<void> {
  try {
    // Single transaction to avoid TOCTOU between user lookup and admin lookup
    const data = await withBypassRls(prisma, async () => {
      const user = await prisma.user.findUnique({
        where: { id: params.userId },
        select: { email: true, tenantId: true },
      });
      if (!user?.tenantId) return null;

      const admins = await prisma.tenantMember.findMany({
        where: {
          tenantId: user.tenantId,
          role: { in: [TENANT_ROLE.OWNER, TENANT_ROLE.ADMIN] },
        },
        select: {
          userId: true,
          user: { select: { email: true, locale: true } },
        },
      });

      return {
        userEmail: user.email ?? "unknown",
        tenantId: user.tenantId,
        admins,
      };
    });

    if (!data) return;

    const timestamp = new Date().toISOString();

    for (const admin of data.admins) {
      if (!admin.user.email) continue;

      try {
        const locale = resolveUserLocale(admin.user.locale);

        const emailTemplate = vaultLockoutEmail(locale, {
          userEmail: data.userEmail,
          attempts: params.attempts,
          lockMinutes: params.lockMinutes,
          ipAddress: params.ip ?? "Unknown",
          timestamp,
        });

        await sendEmail({
          to: admin.user.email,
          subject: emailTemplate.subject,
          html: emailTemplate.html,
          text: emailTemplate.text,
        });

        // Pass tenantId to avoid double DB lookup inside createNotification
        createNotification({
          userId: admin.userId,
          tenantId: data.tenantId,
          type: NOTIFICATION_TYPE.SECURITY_ALERT,
          title: notificationTitle("VAULT_LOCKOUT", locale),
          body: notificationBody(
            "VAULT_LOCKOUT",
            locale,
            data.userEmail,
            String(params.lockMinutes),
          ),
          metadata: {
            userEmail: data.userEmail,
            attempts: params.attempts,
            lockMinutes: params.lockMinutes,
            ipAddress: params.ip,
            timestamp,
          },
        });
      } catch (adminErr) {
        // Per-admin error isolation: one failure must not skip remaining admins
        getLogger().warn(
          { err: adminErr, adminUserId: admin.userId },
          "lockout.adminNotify.perAdmin.error",
        );
      }
    }
  } catch (err) {
    // Fire-and-forget: log but never block the auth/lockout flow
    getLogger().warn({ err, userId: params.userId }, "lockout.adminNotify.error");
  }
}
