import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
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
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";
import { withTenantRls } from "@/lib/tenant-rls";

// GET /api/scim/v2/Users — List/filter users in the tenant
export async function GET(req: NextRequest) {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return scimError(401, API_ERROR[result.error]);
  }
  const { tenantId } = result.data;

  if (!(await checkScimRateLimit(tenantId))) {
    return scimError(429, "Too many requests");
  }

  return withTenantRls(prisma, tenantId, async () => {
    const url = req.nextUrl;
    const startIndex = Math.max(1, parseInt(url.searchParams.get("startIndex") ?? "1", 10) || 1);
    const count = Math.min(200, Math.max(1, parseInt(url.searchParams.get("count") ?? "100", 10) || 100));
    const filterParam = url.searchParams.get("filter");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let prismaWhere: Record<string, any> = { tenantId, user: { is: { email: { not: null } } } };

    if (filterParam) {
      try {
        const ast = parseScimFilter(filterParam);

        const extIdValue = extractExternalIdValue(ast);

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
      prisma.tenantMember.findMany({
        where: prismaWhere,
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
        skip: startIndex - 1,
        take: count,
        orderBy: { createdAt: "asc" },
      }),
      prisma.tenantMember.count({ where: prismaWhere }),
    ]);

    const baseUrl = getScimBaseUrl();

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
  });
}

// POST /api/scim/v2/Users — Create tenant user
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

  try {
    const created = await withTenantRls(prisma, tenantId, async () =>
      prisma.$transaction(async (tx) => {
        let user = await tx.user.findUnique({ where: { email: userName } });
        if (!user) {
          user = await tx.user.create({
            data: {
              tenantId,
              email: userName,
              name: name?.formatted ?? null,
            },
          });
        }

        const existingMember = await tx.tenantMember.findUnique({
          where: { tenantId_userId: { tenantId, userId: user.id } },
        });

        if (existingMember) {
          throw new Error("SCIM_RESOURCE_EXISTS");
        }

        const member = await tx.tenantMember.create({
          data: {
            tenantId,
            userId: user.id,
            role: "MEMBER",
            deactivatedAt: active === false ? new Date() : null,
            scimManaged: true,
            provisioningSource: "SCIM",
            lastScimSyncedAt: new Date(),
          },
        });

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
            await tx.scimExternalMapping.deleteMany({
              where: {
                tenantId,
                internalId: user.id,
                resourceType: "User",
              },
            });
            await tx.scimExternalMapping.create({
              data: {
                teamId: scopedTeamId,
                tenantId,
                externalId,
                resourceType: "User",
                internalId: user.id,
              },
            });
          }
        }

        return { user, member, externalId };
      }),
    );

    logAudit({
      scope: AUDIT_SCOPE.TEAM,
      action: AUDIT_ACTION.SCIM_USER_CREATE,
      userId: auditUserId,
      teamId: scopedTeamId,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: created.user.id,
      metadata: { email: userName, externalId },
      ...extractRequestMeta(req),
    });

    const baseUrl = getScimBaseUrl();
    const resource = userToScimUser(
      {
        userId: created.user.id,
        email: userName,
        name: created.user.name,
        deactivatedAt: created.member.deactivatedAt,
        externalId: created.externalId,
      },
      baseUrl,
    );

    return scimResponse(resource, 201);
  } catch (e) {
    if (e instanceof Error && e.message === "SCIM_RESOURCE_EXISTS") {
      return scimError(409, "User already exists in this tenant", "uniqueness");
    }
    if (e instanceof Error && e.message === "SCIM_EXTERNAL_ID_CONFLICT") {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    if (isScimExternalMappingUniqueViolation(e)) {
      return scimError(409, "externalId is already mapped to a different resource", "uniqueness");
    }
    // Cross-tenant email collision: user.email is globally unique
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return scimError(409, "A user with this email already exists", "uniqueness");
    }
    throw e;
  }
}
