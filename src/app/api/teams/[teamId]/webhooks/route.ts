import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
  encryptServerData,
} from "@/lib/crypto-server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AUDIT_ACTION_VALUES } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string }> };

const MAX_WEBHOOKS_PER_TEAM = 5;

const createWebhookSchema = z.object({
  url: z.string().url().max(2048).refine(
    (u) => {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== "https:") return false;
        const host = parsed.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
        if (host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) return false;
        // Block all IP address literals (IPv4 and IPv6) — only allow FQDNs
        // URL.hostname strips brackets from IPv6 (e.g. "[::1]" → "::1"), so check for colons
        if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
        // Block private/link-local IPs (10.x, 172.16-31.x, 192.168.x, 169.254.x)
        const parts = host.split(".").map(Number);
        if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
          if (parts[0] === 10) return false;
          if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
          if (parts[0] === 192 && parts[1] === 168) return false;
          if (parts[0] === 169 && parts[1] === 254) return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    { message: "URL must use HTTPS and must not point to private/internal addresses" },
  ),
  events: z.array(z.enum(AUDIT_ACTION_VALUES as unknown as [string, ...string[]])).min(1).max(AUDIT_ACTION_VALUES.length),
});

// GET /api/teams/[teamId]/webhooks — List team webhooks
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const webhooks = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.findMany({
      where: { teamId },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        failCount: true,
        lastDeliveredAt: true,
        lastFailedAt: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json({ webhooks });
}

// POST /api/teams/[teamId]/webhooks — Create a webhook
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }
  const parsed = createWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Check webhook count limit
  const existingCount = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.count({ where: { teamId } }),
  );
  if (existingCount >= MAX_WEBHOOKS_PER_TEAM) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { limit: `Maximum ${MAX_WEBHOOKS_PER_TEAM} webhooks per team` } },
      { status: 400 },
    );
  }

  // Generate HMAC secret and encrypt it
  const plainSecret = randomBytes(32).toString("hex");
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const encrypted = encryptServerData(plainSecret, masterKey);

  // Resolve tenantId from team
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );

  const webhook = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.create({
      data: {
        teamId,
        tenantId: team.tenantId,
        url: parsed.data.url,
        secretEncrypted: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        masterKeyVersion: version,
        events: parsed.data.events,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.WEBHOOK_CREATE,
    userId: session.user.id,
    teamId,
    metadata: { webhookId: webhook.id, url: parsed.data.url },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      webhook: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        isActive: webhook.isActive,
        createdAt: webhook.createdAt,
      },
      secret: plainSecret,
    },
    { status: 201 },
  );
}
