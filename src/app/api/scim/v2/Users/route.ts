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
import { resolveExistingUsersForTenant } from "@/lib/tenant-context";
import { isUniqueViolationOn, ONE_ACTIVE_MEMBERSHIP_INDEX } from "@/lib/prisma/prisma-error";
import { withRequestLog } from "@/lib/http/with-request-log";
import { REALIGNMENT_SOURCE, realignAfterActivation } from "@/lib/tenant/tenant-realignment";
import { SCIM_USER_NOT_PROVISIONABLE_DETAIL, toScimUserResource } from "@/lib/services/scim-user-service";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
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

  // The cross-tenant guards, hoisted OUT of the tenant context because they cannot
  // work inside one: the users and memberships they must see are the rows RLS
  // hides there, and a nested bypass is refused by the nesting guard.
  //
  // A SCIM token may attach an EXISTING user only if this tenant owns them. A user
  // owned by another tenant — even one active nowhere, released by that tenant —
  // is refused: attaching and then realigning them handed their tenancy to
  // whichever tenant named their email first (round-5 S1). They join this tenant
  // by signing in through its IdP; SCIM can manage them after that.
  const emailKey = userName.toLowerCase();
  const resolution = (await resolveExistingUsersForTenant(tenantId, [emailKey])).get(emailKey);
  if (resolution && resolution.kind !== "owned") {
    return scimError(409, SCIM_USER_NOT_PROVISIONABLE_DETAIL, "uniqueness");
  }
  // No uniqueness read for an owned user: owning them means no active membership
  // in another tenant, so that 409 could no longer be reached (round-7 F-R7-4).
  // The race in which another tenant activates them first is the index handler's.
  const existingUserId = resolution?.kind === "owned" ? resolution.userId : null;

  try {
    const created = await withTenantRls(prisma, tenantId, async (tx) => {
      // The user the guard resolved as this tenant's own, or a new one.
      const user = existingUserId
        ? { id: existingUserId }
        : await tx.user.create({
            data: {
              tenantId,
              email: userName,
              name: name?.formatted ?? null,
            },
            select: { id: true },
          });

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

    // An ACTIVE membership for a user this tenant already owned by an old column
    // copy may still leave the column behind. Moved after the commit, from outside
    // this tenant's context; a failure is logged, not answered as a failed
    // provision whose membership already committed.
    if (existingUserId && created.member.deactivatedAt === null) {
      try {
        await realignAfterActivation(existingUserId, tenantId, {
          source: REALIGNMENT_SOURCE.SCIM,
          actorUserId: auditUserId,
          actorType,
        });
      } catch (error) {
        getLogger().error({ tenantId, userId: existingUserId, error: errorLogFields(error) }, "scim.realign-failed");
      }
    }

    const resource = await toScimUserResource(
      { userId: created.user.id, deactivatedAt: created.member.deactivatedAt, externalId: created.externalId },
      getScimBaseUrl(),
    );
    if (!resource) return scimError(404, "User not found");

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
    // The one-active-membership index: another tenant activated the user between
    // the ownership read and this write. That tenant owns them now, so the answer
    // is the ownership refusal's detail — a separate one told the token holder
    // whether another tenant had the user active (round-7 R7-S3).
    if (isUniqueViolationOn(e, ONE_ACTIVE_MEMBERSHIP_INDEX)) {
      return scimError(409, SCIM_USER_NOT_PROVISIONABLE_DETAIL, "uniqueness");
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
