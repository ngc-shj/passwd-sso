import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { createRateLimiter } from "@/lib/rate-limit";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { watchtowerAlertEmail } from "@/lib/email/templates/watchtower-alert";
import { serverAppUrl } from "@/lib/url-helpers";
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls } from "@/lib/tenant-context";
import { notificationTitle, notificationBody } from "@/lib/notification-messages";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/notification";

export const runtime = "nodejs";

const alertLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1,
});

const alertSchema = z.object({
  newBreachCount: z.number().int().nonnegative().max(10000),
  teamId: z.string().trim().min(1).optional(),
});

// POST /api/watchtower/alert
// Called by the client after auto-monitor detects new breaches.
export async function POST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_BODY }, { status: 400 });
  }

  const parsed = alertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.INVALID_BODY }, { status: 400 });
  }

  const { newBreachCount, teamId } = parsed.data;

  const rateLimitKey = teamId
    ? `rl:watchtower:alert:team:${teamId}`
    : `rl:watchtower:alert:${session.user.id}`;
  const { allowed } = await alertLimiter.check(rateLimitKey);
  if (!allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  // Verify team membership when teamId is provided
  if (teamId) {
    try {
      await requireTeamMember(session.user.id, teamId);
    } catch (e) {
      if (e instanceof TeamAuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
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
  logAudit({
    scope: teamId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.WATCHTOWER_ALERT_SENT,
    userId: session.user.id,
    ...(teamId ? { teamId } : {}),
    metadata: { newBreachCount, ...(teamId ? { teamId } : {}) },
    ...extractRequestMeta(req),
  });

  // Send email notification if configured
  if (user?.email) {
    const { subject, html, text } = watchtowerAlertEmail(locale, newBreachCount, serverAppUrl(""));
    void sendEmail({ to: user.email, subject, html, text });
  }

  return NextResponse.json({ ok: true });
}
