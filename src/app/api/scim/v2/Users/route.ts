import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
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
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";
import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { wouldCreateSecondActiveMembership } from "@/lib/tenant-context";
import { isUniqueViolationOn, ONE_ACTIVE_MEMBERSHIP_INDEX } from "@/lib/prisma/prisma-error";
import { withRequestLog } from "@/lib/http/with-request-log";
import { scimParseBody } from "@/lib/scim/parse-body";
import { authorizeScim } from "@/lib/scim/with-scim-auth";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";
import {
  SCIM_PAGE_COUNT_MIN,
  SCIM_PAGE_COUNT_MAX,
  SCIM_PAGE_COUNT_DEFAULT,
} from "@/lib/validations/common.server";

// GET /api/scim/v2/Users — List/filter users in the tenant
async function handleGET(req: NextRequest) {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.data;

  // Read under a bypass pinned to the token's tenant in every query, not in the
  // tenant context. The list's meaning is a filter through the users relation —
  // `userName` is the email, and a user without one is not listed — and a tenant
  // context evaluates that relation under users RLS: a member whose users row
  // names another tenant, such as a departed member the realignment moved, was
  // dropped from `Resources` and from `totalResults` alike (measured: a relation
  // filter excludes the row; Prisma does not throw). Read-only.
  return withBypassRls(prisma, async (tx) => {
    const url = req.nextUrl;
    const startIndex = Math.max(1, parseInt(url.searchParams.get("startIndex") ?? "1", 10) || 1);
    const count = Math.min(SCIM_PAGE_COUNT_MAX, Math.max(SCIM_PAGE_COUNT_MIN, parseInt(url.searchParams.get("count") ?? String(SCIM_PAGE_COUNT_DEFAULT), 10) || SCIM_PAGE_COUNT_DEFAULT));
    const filterParam = url.searchParams.get("filter");

    // Every condition is ANDed under the token's tenant, so no filter can widen it.
    const conditions: Prisma.TenantMemberWhereInput[] = [
      { tenantId },
      { user: { is: { email: { not: null } } } },
    ];

    if (filterParam) {
      try {
        const ast = parseScimFilter(filterParam);

        const extIdValue = extractExternalIdValue(ast);

        if (extIdValue !== null && "or" in ast) {
          return scimError(400, "externalId filter is not supported in OR expressions");
        }

        if (extIdValue !== null) {
          const mapping = await tx.scimExternalMapping.findFirst({
            where: {
              tenantId,
              externalId: extIdValue,
              resourceType: "User",
            },
          });
          if (!mapping) {
            return scimListResponse([], 0, startIndex);
          }
          conditions.push({ userId: mapping.internalId });
        }

        conditions.push(filterToPrismaWhere(ast));
      } catch (e) {
        if (e instanceof FilterParseError) {
          return scimError(400, e.message);
        }
        throw e;
      }
    }

    const prismaWhere: Prisma.TenantMemberWhereInput = { AND: conditions };
    const [members, totalResults] = await Promise.all([
      tx.tenantMember.findMany({
        where: prismaWhere,
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
        skip: startIndex - 1,
        take: count,
        orderBy: { createdAt: "asc" },
      }),
      tx.tenantMember.count({ where: prismaWhere }),
    ]);

    const baseUrl = getScimBaseUrl();

    const userIds = members.map((m) => m.userId);
    const mappings = await tx.scimExternalMapping.findMany({
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
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

// POST /api/scim/v2/Users — Create tenant user
async function handlePOST(req: NextRequest) {
  const auth = await authorizeScim(req);
  if (!auth.ok) return auth.response;
  const { tenantId, auditUserId, actorType } = auth.data;

  const bodyResult = await scimParseBody(req, scimUserSchema);
  if (!bodyResult.ok) return bodyResult.response;
  const { userName, name, externalId, active } = bodyResult.data;

  // The cross-tenant guard, hoisted OUT of the tenant context because it could
  // not work inside one. It was doubly vacuous: gated on `user.tenantId !==
  // tenantId` — the denormalized column this whole class is about — and, even
  // when entered, querying `tenantId: { not: tenantId }` under
  // `withTenantRls`, which RLS has already restricted to `tenantId`. The set was
  // structurally empty, so the 409 its own error mapping exists for could never
  // be reached. Same placement as the PUT/PATCH arms in `[id]/route.ts`, for the
  // same reason: the foreign membership row is what RLS hides inside a tenant
  // context, and a nested bypass is refused by the nesting guard.
  const existingUserId = await withBypassRls(
    prisma,
    async (tx) => {
      const found = await tx.user.findUnique({
        where: { email: userName },
        select: { id: true },
      });
      return found?.id ?? null;
    },
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );
  if (existingUserId && (await wouldCreateSecondActiveMembership(existingUserId, tenantId))) {
    return scimError(409, "User already belongs to another organization", "uniqueness");
  }

  try {
    const created = await withTenantRls(prisma, tenantId, async (tx) => {
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
          role: TENANT_ROLE.MEMBER,
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
              tenantId,
              externalId,
              resourceType: "User",
              internalId: user.id,
            },
          });
        }
      }

      return { user, member, externalId };
    });

    await logAuditAsync({
      ...tenantAuditBase(req, auditUserId, tenantId),
      actorType,
      action: AUDIT_ACTION.SCIM_USER_CREATE,
      targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
      targetId: created.user.id,
      metadata: { email: userName, externalId },
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
    // The one-active-membership index, reached only on the race the guard above
    // cannot close: it runs in its own context a round trip earlier, and another
    // tenant can activate in between. Mapped to the same 409 the guard returns,
    // with its own message so the two are distinguishable in the log.
    if (isUniqueViolationOn(e, ONE_ACTIVE_MEMBERSHIP_INDEX)) {
      return scimError(409, "User already belongs to another organization", "uniqueness");
    }
    // Cross-tenant email collision: user.email is globally unique
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return scimError(409, "A user with this email already exists", "uniqueness");
    }
    throw e;
  }
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
