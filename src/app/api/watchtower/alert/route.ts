import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/http/parse-body";
import { assertOrigin } from "@/lib/auth/csrf";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { requireTeamMember } from "@/lib/auth/team-auth";
import { logAuditAsync, personalAuditBase, teamAuditBase } from "@/lib/audit/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { watchtowerAlertEmail } from "@/lib/email/templates/watchtower-alert";
import { serverAppUrl } from "@/lib/url-helpers";
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls } from "@/lib/tenant-context";
import { notificationTitle, notificationBody } from "@/lib/notification/notification-messages";
import { AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/audit/notification";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, rateLimited, unauthorized } from "@/lib/http/api-response";
import { BREACH_COUNT_MAX } from "@/lib/validations/common.server";
import { MS_PER_HOUR } from "@/lib/constants/time";

export const runtime = "nodejs";

const alertLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 1,
});

const alertSchema = z.object({
  newBreachCount: z.number().int().nonnegative().max(BREACH_COUNT_MAX),
  teamId: z.string().trim().min(1).optional(),
});

// POST /api/watchtower/alert
// Called by the client after auto-monitor detects new breaches.
async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // Note: parseBody runs before rate limit because the rate limit key depends
  // on teamId from the parsed body. This is acceptable since auth is checked first.
  const result = await parseBody(req, alertSchema);
  if (!result.ok) return result.response;
  const { newBreachCount, teamId } = result.data;

  const rateLimitKey = teamId
    ? `rl:watchtower:alert:team:${teamId}:${session.user.id}`
    : `rl:watchtower:alert:${session.user.id}`;
  const rl = await alertLimiter.check(rateLimitKey);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Verify team membership when teamId is provided
  if (teamId) {
    try {
      await requireTeamMember(session.user.id, teamId);
    } catch (e) {
      return handleAuthError(e);
    }
  }

  // Resolve user locale for i18n (notification + email)
  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true, locale: true },
    }),
  );
  const locale = resolveUserLocale(user?.locale);

  // Create in-app notification
  createNotification({
    userId: session.user.id,
    type: NOTIFICATION_TYPE.WATCHTOWER_ALERT,
    title: notificationTitle("WATCHTOWER_ALERT", locale),
    body: notificationBody("WATCHTOWER_ALERT", locale, String(newBreachCount)),
    metadata: { breachCount: newBreachCount },
  });

  // Audit log
  await logAuditAsync({
    ...(teamId
      ? teamAuditBase(req, session.user.id, teamId)
      : personalAuditBase(req, session.user.id)),
    action: AUDIT_ACTION.WATCHTOWER_ALERT_SENT,
    metadata: { newBreachCount, ...(teamId ? { teamId } : {}) },
  });

  // Send email notification if configured
  if (user?.email) {
    const { subject, html, text } = watchtowerAlertEmail(locale, newBreachCount, serverAppUrl(""));
    void sendEmail({ to: user.email, subject, html, text });
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
