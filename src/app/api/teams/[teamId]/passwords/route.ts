import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { checkAuth } from "@/lib/check-auth";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { createTeamE2EPasswordSchema } from "@/lib/validations";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { parseBody } from "@/lib/parse-body";
import type { EntryType } from "@prisma/client";
import { ENTRY_TYPE_VALUES, TEAM_PERMISSION, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE, EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { FILENAME_MAX_LENGTH } from "@/lib/validations/common";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized } from "@/lib/api-response";
import * as teamPasswordService from "@/lib/services/team-password-service";
import { TeamPasswordServiceError } from "@/lib/services/team-password-service";

type Params = { params: Promise<{ teamId: string }> };

const VALID_ENTRY_TYPES: Set<string> = new Set(ENTRY_TYPE_VALUES);

// GET /api/teams/[teamId]/passwords — List team passwords (encrypted overviews, optionally blobs)
async function handleGET(req: NextRequest, { params }: Params) {
  const authed = await checkAuth(req, { scope: EXTENSION_TOKEN_SCOPE.PASSWORDS_READ });
  if (!authed.ok) return authed.response;
  const { userId } = authed.auth;

  const { teamId } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.PASSWORD_READ, req);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const tagId = searchParams.get("tag");
  const folderId = searchParams.get("folder");
  const rawType = searchParams.get("type");
  const entryType = rawType && VALID_ENTRY_TYPES.has(rawType) ? (rawType as EntryType) : null;
  const includeBlob = searchParams.get("include") === "blob";
  const favoritesOnly = searchParams.get("favorites") === "true";
  const trashOnly = searchParams.get("trash") === "true";
  const archivedOnly = searchParams.get("archived") === "true";

  const entries = await withTeamTenantRls(teamId, () =>
    teamPasswordService.listTeamPasswords(teamId, {
      userId,
      tagId,
      folderId,
      entryType,
      includeBlob,
      favoritesOnly,
      trashOnly,
      archivedOnly,
    }),
  );

  // Auto-purge items deleted more than 30 days ago (async nonblocking, F-20)
  if (!trashOnly) {
    withTeamTenantRls(teamId, () =>
      teamPasswordService.purgeExpiredTeamPasswords(teamId),
    ).catch(() => {});
  }

  return NextResponse.json(entries);
}

// POST /api/teams/[teamId]/passwords — Create team password (E2E: client encrypts)
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_CREATE, req);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const result = await parseBody(req, createTeamE2EPasswordSchema);
  if (!result.ok) return result.response;

  const { id: clientId, encryptedBlob, encryptedOverview, aadVersion, teamKeyVersion, itemKeyVersion, encryptedItemKey, entryType, tagIds, teamFolderId, requireReprompt, expiresAt } = result.data;

  let entry;
  try {
    entry = await withTeamTenantRls(teamId, () =>
      teamPasswordService.createTeamPassword(teamId, {
        id: clientId,
        encryptedBlob,
        encryptedOverview,
        aadVersion,
        teamKeyVersion,
        itemKeyVersion,
        encryptedItemKey,
        entryType,
        userId: session.user.id,
        tagIds,
        teamFolderId,
        requireReprompt,
        expiresAt,
      }),
    );
  } catch (e) {
    if (e instanceof TeamPasswordServiceError) {
      return errorResponse(e.code, e.statusHint);
    }
    throw e;
  }

  await logAuditAsync({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_CREATE,
    userId: session.user.id,
    teamId: teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: entry.id,
    metadata: (() => {
      if (req.headers.get("x-passwd-sso-source") !== "import") return undefined;
      const rawFilename = req.headers.get("x-passwd-sso-filename")?.trim() ?? "";
      const filename = rawFilename
        ? rawFilename
            .replace(/[\0\x01-\x1f\x7f-\x9f]/g, "")
            .replace(/[/\\]/g, "_")
            .trim()
            .slice(0, FILENAME_MAX_LENGTH) || undefined
        : undefined;
      return filename
        ? {
            source: "import" as const,
            filename,
            parentAction: AUDIT_ACTION.ENTRY_IMPORT,
          }
        : {
            source: "import" as const,
            parentAction: AUDIT_ACTION.ENTRY_IMPORT,
          };
    })(),
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      id: entry.id,
      entryType: entry.entryType,
      tags: entry.tags,
      createdAt: entry.createdAt,
    },
    { status: 201 }
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
