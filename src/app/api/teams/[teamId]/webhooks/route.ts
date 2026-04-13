import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
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
import { assertOrigin } from "@/lib/csrf";
import { z } from "zod";
import { TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { MAX_WEBHOOKS, WEBHOOK_URL_MAX_LENGTH } from "@/lib/validations/common";

type Params = { params: Promise<{ teamId: string }> };

const createWebhookSchema = z.object({
  url: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(
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
        return true;
      } catch {
        return false;
      }
    },
    { message: "URL must use HTTPS and must not point to private/internal addresses" },
  ),
  events: z.array(z.enum(TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS as unknown as [string, ...string[]])).min(1).max(TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS.length),
});

// GET /api/teams/[teamId]/webhooks — List team webhooks
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
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
async function handlePOST(req: NextRequest, { params }: Params) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const result = await parseBody(req, createWebhookSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Check webhook count limit
  const existingCount = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.count({ where: { teamId } }),
  );
  if (existingCount >= MAX_WEBHOOKS) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { limit: `Maximum ${MAX_WEBHOOKS} webhooks per team` } },
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
        url: data.url,
        secretEncrypted: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        masterKeyVersion: version,
        events: data.events,
      },
    }),
  );

  await logAuditAsync({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.WEBHOOK_CREATE,
    userId: session.user.id,
    teamId,
    metadata: { webhookId: webhook.id, url: data.url },
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

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
