import { randomBytes, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { adminVaultResetEmail } from "@/lib/email/templates/admin-vault-reset";
import { resolveUserLocale } from "@/lib/locale";
import { requireTeamPermission, isRoleAbove, TeamAuthError } from "@/lib/team-auth";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { TEAM_PERMISSION, AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/notification";

export const runtime = "nodejs";

const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_PENDING_RESETS = 3;

const adminResetLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
});

const targetResetLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1,
});

// POST /api/teams/[teamId]/members/[memberId]/reset-vault
// Initiate a vault reset for a team member. Admin/Owner only.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string; memberId: string }> },
) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, memberId } = await params;

  // Authorization: require MEMBER_VAULT_RESET permission
  let actorMembership;
  try {
    actorMembership = await requireTeamPermission(
      session.user.id,
      teamId,
      TEAM_PERMISSION.MEMBER_VAULT_RESET,
    );
  } catch (err) {
    if (err instanceof TeamAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Find the target member
  const targetMember = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findFirst({
      where: { id: memberId, teamId, deactivatedAt: null },
      include: { user: { select: { id: true, email: true, name: true, locale: true } } },
    }),
  );

  if (!targetMember) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Cannot reset own vault via admin reset
  if (targetMember.userId === session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  // Role hierarchy check: actor must be strictly above target
  if (!isRoleAbove(actorMembership.role, targetMember.role)) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  // Rate limits
  const [adminAllowed, targetAllowed] = await Promise.all([
    adminResetLimiter.check(`rl:admin-reset:admin:${session.user.id}:${teamId}`),
    targetResetLimiter.check(`rl:admin-reset:target:${targetMember.userId}`),
  ]);

  if (!adminAllowed || !targetAllowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  // Check pending resets limit
  const pendingCount = await withTeamTenantRls(teamId, async () =>
    prisma.adminVaultReset.count({
      where: {
        targetUserId: targetMember.userId,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  );

  if (pendingCount >= MAX_PENDING_RESETS) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  // Generate token
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  // Get team info for email
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true, tenantId: true },
    }),
  );

  if (!team) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Create the reset record
  await withTeamTenantRls(teamId, async () =>
    prisma.adminVaultReset.create({
      data: {
        tenantId: team.tenantId,
        teamId,
        targetUserId: targetMember.userId,
        initiatedById: session.user.id,
        tokenHash,
        expiresAt,
      },
    }),
  );

  // Audit log
  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
    userId: session.user.id,
    teamId,
    targetType: "User",
    targetId: targetMember.userId,
    ...extractRequestMeta(req),
  });

  // In-app notification to target user
  createNotification({
    userId: targetMember.userId,
    tenantId: team.tenantId,
    type: NOTIFICATION_TYPE.ADMIN_VAULT_RESET,
    title: "Vault reset initiated",
    body: `A team admin has initiated a vault reset for your account.`,
  });

  // Email notification to target user
  if (targetMember.user.email) {
    const locale = resolveUserLocale(targetMember.user.locale);
    const appUrl = process.env.APP_URL || process.env.AUTH_URL || "";
    // Token in URL fragment (not sent to server in logs)
    const resetUrl = `${appUrl}/${locale}/dashboard/vault-reset#token=${token}`;
    const adminName = session.user.name ?? session.user.email ?? "";
    const { subject, html, text } = adminVaultResetEmail(
      locale,
      adminName,
      team.name,
      resetUrl,
    );
    void sendEmail({ to: targetMember.user.email, subject, html, text });
  }

  return NextResponse.json({ ok: true });
}
