import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateScimToken } from "@/lib/scim-token";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import {
  scimResponse,
  scimError,
  scimListResponse,
  getScimBaseUrl,
} from "@/lib/scim/response";
import { userToScimUser, type ScimUserInput } from "@/lib/scim/serializers";
import {
  parseScimFilter,
  filterToPrismaWhere,
  extractExternalIdValue,
  FilterParseError,
} from "@/lib/scim/filter-parser";
import { scimUserSchema } from "@/lib/scim/validations";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_ROLE, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";

// GET /api/scim/v2/Users — List/filter users in the team
export async function GET(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { teamId: scopedTeamId, tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  const url = req.nextUrl;
  const startIndex = Math.max(1, parseInt(url.searchParams.get("startIndex") ?? "1", 10) || 1);
  const count = Math.min(200, Math.max(1, parseInt(url.searchParams.get("count") ?? "100", 10) || 100));
  const filterParam = url.searchParams.get("filter");

  // Build Prisma where clause.
  // No deactivatedAt filter by default — RFC 7644 §3.4.2 requires unfiltered
  // GET to return all resources. The `active` field distinguishes state.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prismaWhere: Record<string, any> = { orgId: scopedTeamId, user: { email: { not: null } } };

  if (filterParam) {
    try {
      const ast = parseScimFilter(filterParam);

      // Pre-resolve externalId via ScimExternalMapping before building WHERE.
      const extIdValue = extractExternalIdValue(ast);

      // Reject externalId in OR expressions — semantics are ambiguous
      if (extIdValue !== null && "or" in ast) {
        return scimError(400, "externalId filter is not supported in OR expressions");
      }

      if (extIdValue !== null) {
        const mapping = await prisma.scimExternalMapping.findFirst({
          where: {
            tenantId,
            externalId: extIdValue,
            resourceType: "User",
          },
        });
        if (!mapping) {
          return scimListResponse([], 0, startIndex);
        }
        prismaWhere.userId = mapping.internalId;
      }

      const where = filterToPrismaWhere(ast);
      prismaWhere = { ...prismaWhere, ...where };
    } catch (e) {
      if (e instanceof FilterParseError) {
        return scimError(400, e.message);
      }
      throw e;
    }
  }

  const [members, totalResults] = await Promise.all([
    prisma.orgMember.findMany({
      where: prismaWhere,
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
      skip: startIndex - 1,
      take: count,
      orderBy: { createdAt: "asc" },
    }),
    prisma.orgMember.count({ where: prismaWhere }),
  ]);

  const baseUrl = getScimBaseUrl();

  // Batch-fetch external IDs for the result set
  const userIds = members.map((m) => m.userId);
  const mappings = await prisma.scimExternalMapping.findMany({
    where: {
      tenantId,
      resourceType: "User",
      internalId: { in: userIds },
    },
    select: { internalId: true, externalId: true },
  });
  const extIdMap = new Map(mappings.map((m) => [m.internalId, m.externalId]));

  const resources = members.map((m) => {
      const input: ScimUserInput = {
        userId: m.userId,
        email: m.user.email!,
        name: m.user.name,
        deactivatedAt: m.deactivatedAt,
        externalId: extIdMap.get(m.userId),
      };
      return userToScimUser(input, baseUrl);
    });

  return scimListResponse(resources, totalResults, startIndex);
}

// POST /api/scim/v2/Users — Create (provision) a user in the team
export async function POST(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { teamId: scopedTeamId, tenantId, auditUserId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON");
  }

  const parsed = scimUserSchema.safeParse(body);
  if (!parsed.success) {
    return scimError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { userName, name, externalId, active } = parsed.data;

  // Transaction: find/create user + create TeamMember + create ScimExternalMapping
  try {
    const created = await prisma.$transaction(async (tx) => {
      // Find or create User by email
      let user = await tx.user.findUnique({ where: { email: userName } });
      if (!user) {
        user = await tx.user.create({
          data: {
            email: userName,
            name: name?.formatted ?? null,
          },
        });
      }

      // Check for existing TeamMember
      const existingMember = await tx.orgMember.findUnique({
        where: { orgId_userId: { orgId: scopedTeamId, userId: user.id } },
      });

      if (existingMember) {
        if (existingMember.deactivatedAt !== null) {
          // Re-activate deactivated member
          await tx.orgMember.update({
            where: { id: existingMember.id },
            data: {
              deactivatedAt: active === false ? new Date() : null,
              scimManaged: true,
            },
          });
        } else {
          // Already active — 409 uniqueness conflict
          throw new Error("SCIM_RESOURCE_EXISTS");
        }
      } else {
        // Create new TeamMember
        await tx.orgMember.create({
          data: {
            orgId: scopedTeamId,
            userId: user.id,
            role: TEAM_ROLE.MEMBER,
            scimManaged: true,
            keyDistributed: false,
            deactivatedAt: active === false ? new Date() : null,
          },
        });
      }

      // Create external mapping (if externalId provided)
      if (externalId) {
        const existing = await tx.scimExternalMapping.findFirst({
          where: {
            tenantId,
            externalId,
            resourceType: "User",
          },
        });
        if (existing && existing.internalId !== user.id) {
          throw new Error("SCIM_EXTERNAL_ID_CONFLICT");
        }
        if (!existing) {
          // Delete stale mapping for this user (handles externalId change on re-activation)
          await tx.scimExternalMapping.deleteMany({
            where: {
              tenantId,
              internalId: user.id,
              resourceType: "User",
            },
          });
          await tx.scimExternalMapping.create({
            data: {
              orgId: scopedTeamId,
              tenantId,
              externalId,
              resourceType: "User",
              internalId: user.id,
            },
          });
        }
      }

      // Re-fetch to get latest state
      const member = await tx.orgMember.findUnique({
        where: { orgId_userId: { orgId: scopedTeamId, userId: user.id } },
      });

      return { user, member: member!, externalId, reactivated: !!existingMember };
    });

    logAudit({
      scope: AUDIT_SCOPE.TEAM,
      action: created.reactivated ? AUDIT_ACTION.SCIM_USER_REACTIVATE : AUDIT_ACTION.SCIM_USER_CREATE,
      userId: auditUserId,
      orgId: scopedTeamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: created.user.id,
      metadata: { email: userName, externalId },
      ...extractRequestMeta(req),
    });

    const baseUrl = getScimBaseUrl();
    const resource = userToScimUser(
      {
        userId: created.user.id,
        email: userName, // already validated by Zod
        name: created.user.name,
        deactivatedAt: created.member.deactivatedAt,
        externalId: created.externalId,
      },
      baseUrl,
    );

    return scimResponse(resource, 201);
  } catch (e) {
    if (e instanceof Error && e.message === "SCIM_RESOURCE_EXISTS") {
      return scimError(409, "User already exists in this team", "uniqueness");
    }
    if (e instanceof Error && e.message === "SCIM_EXTERNAL_ID_CONFLICT") {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    if (isScimExternalMappingUniqueViolation(e)) {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    throw e;
  }
}
