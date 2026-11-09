import type { NextRequest } from "next/server";
import type { Prisma, TenantRole } from "@prisma/client";
import { logAuditInTx, tenantAuditBase } from "@/lib/audit/audit";
import type { AuditLogParams } from "@/lib/audit/audit-payload";
import { hasTenantPermission, type TenantPermission } from "@/lib/auth/access/tenant-auth";
import { transition } from "@/lib/emergency-access/emergency-access-state";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, EA_ACTOR, EA_STATUS, TENANT_ROLE } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import type { MemberContainmentInput } from "@/lib/validations/member-containment";

/**
 * Containment of a member whose session may be compromised (#1016), beyond the
 * passkeys and sessions revokeMemberPasskeys ends: the IdP accounts linked to
 * them, and the footholds they created that outlive their sessions.
 *
 * Every function here receives the caller's transaction and makes no
 * withBypassRls call: the GET route reads under TENANT_MEMBER_PASSKEY_LIST and
 * revokeMemberPasskeys writes under TENANT_MEMBER_PASSKEY_REVOKE. Under that
 * bypass, every query on a tenant-owned kind names the admin's tenant itself;
 * accounts and emergency-access grants are the user's and match on the user.
 *
 * NOT part of revokeUserAuthArtifactsInTx: these rows do not authenticate as
 * the user (user-auth-artifacts.member-set.test.ts), so ending a session never
 * touches them. Only an admin's explicit choice does.
 */

export const FOOTHOLD_KIND = {
  SCIM_TOKENS: "scimTokens",
  SERVICE_ACCOUNTS: "serviceAccounts",
  SERVICE_ACCOUNT_TOKENS: "serviceAccountTokens",
  MCP_CLIENTS: "mcpClients",
  BREAKGLASS_GRANTS: "breakglassGrants",
  EMERGENCY_ACCESS_GRANTS: "emergencyAccessGrants",
} as const;

export type FootholdKind = (typeof FOOTHOLD_KIND)[keyof typeof FOOTHOLD_KIND];

/** In the pinned write order: emergency-access grants last. */
const FOOTHOLD_KINDS: readonly FootholdKind[] = Object.values(FOOTHOLD_KIND);

// What managing each kind takes outside this flow. MEMBER_MANAGE (which the
// route already requires) is the gate; these are defence in depth — OWNER and
// ADMIN hold all of them today. An emergency-access grant is the member's own,
// with no tenant permission of its own.
const KIND_PERMISSION: Record<FootholdKind, TenantPermission | null> = {
  scimTokens: TENANT_PERMISSION.SCIM_MANAGE,
  serviceAccounts: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
  serviceAccountTokens: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
  mcpClients: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
  breakglassGrants: TENANT_PERMISSION.BREAKGLASS_REQUEST,
  emergencyAccessGrants: null,
};

/** Whether an actor of `role` may list and contain footholds of `kind`. */
export function mayContainKind(role: TenantRole, kind: FootholdKind): boolean {
  const permission = KIND_PERMISSION[kind];
  if (permission !== null && !hasTenantPermission(role, permission)) return false;
  // The break-glass revoke route's rule: the requester or an OWNER. The
  // requester here is the member being contained, so only an OWNER.
  if (kind === FOOTHOLD_KIND.BREAKGLASS_GRANTS && role !== TENANT_ROLE.OWNER) return false;
  return true;
}

/** What one containment request names, deduplicated; every kind present. */
export interface MemberContainmentRequest {
  unlinkAccountIds: readonly string[];
  revoke: Readonly<Record<FootholdKind, readonly string[]>>;
}

const unique = (ids: readonly string[] | undefined): string[] => [...new Set(ids ?? [])];

/** The request a validated body makes, or null when it names nothing. */
export function toContainmentRequest(input: MemberContainmentInput | null): MemberContainmentRequest | null {
  if (!input) return null;
  const revoke = input.revoke ?? {};
  const request: MemberContainmentRequest = {
    unlinkAccountIds: unique(input.unlinkAccountIds),
    revoke: {
      scimTokens: unique(revoke.scimTokenIds),
      serviceAccounts: unique(revoke.serviceAccountIds),
      serviceAccountTokens: unique(revoke.serviceAccountTokenIds),
      mcpClients: unique(revoke.mcpClientIds),
      breakglassGrants: unique(revoke.breakglassGrantIds),
      emergencyAccessGrants: unique(revoke.emergencyAccessGrantIds),
    },
  };
  const named = request.unlinkAccountIds.length + FOOTHOLD_KINDS.reduce((n, k) => n + request.revoke[k].length, 0);
  return named === 0 ? null : request;
}

/** The kinds a request names that an actor of `role` may not contain. */
export function refusedContainmentKinds(role: TenantRole, request: MemberContainmentRequest): FootholdKind[] {
  return FOOTHOLD_KINDS.filter((k) => request.revoke[k].length > 0 && !mayContainKind(role, k));
}

// ─── Live predicates (C3) ─────────────────────────────────
//
// Spelled as object literals in each function, not built by a shared helper:
// check-bypass-rls reads a query's where clause to find the models it reaches
// through relations, and cannot read one returned by a call. Each spelling is
// held equal to the other by member-containment.test.ts.
//
// - SCIM token: the admin's tenant, minted by the member, not revoked, not expired.
// - Service account / MCP client: the admin's tenant, created by the member, active.
// - Service-account token: the admin's tenant (any of its service accounts),
//   minted by the member, not revoked, not expired.
// - Break-glass grant: the admin's tenant, requested by the member, not
//   revoked, not expired — one still in its cooling-off (effectiveAt in the
//   future) is live: it becomes usable by itself.
// - Emergency-access grant: the member's own, in whichever tenant it was
//   filed under, not revoked or rejected.

// ─── Listing (C3) ─────────────────────────────────────────

export interface MemberContainmentListing {
  /** Never providerAccountId or any token: not needed to choose an unlink. */
  linkedAccounts: { id: string; provider: string; linkedInTenant: boolean }[];
  /** Only the kinds the actor may contain. */
  createdFootholds: Partial<Record<FootholdKind, unknown[]>>;
}

/** The member's linked accounts and the live footholds they created. */
export async function listMemberContainment(
  tx: Prisma.TransactionClient,
  { tenantId, targetUserId, role, now = new Date() }: { tenantId: string; targetUserId: string; role: TenantRole; now?: Date },
): Promise<MemberContainmentListing> {
  const scimLive = { tenantId, createdById: targetUserId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const saLive = { tenantId, createdById: targetUserId, isActive: true };
  const saTokenLive = { tenantId, createdById: targetUserId, revokedAt: null, expiresAt: { gt: now } };
  const mcpLive = { tenantId, createdById: targetUserId, isActive: true };
  const breakglassLive = { tenantId, requesterId: targetUserId, revokedAt: null, expiresAt: { gt: now } };
  const eaLive = { ownerId: targetUserId, status: { notIn: [EA_STATUS.REVOKED, EA_STATUS.REJECTED] } };
  const accounts = await tx.account.findMany({
    where: { userId: targetUserId },
    select: { id: true, provider: true, tenantId: true },
    orderBy: { provider: "asc" },
  });

  const listers: Record<FootholdKind, () => Promise<unknown[]>> = {
    scimTokens: () =>
      tx.scimToken.findMany({
        where: scimLive,
        select: { id: true, description: true, createdAt: true, expiresAt: true, lastUsedAt: true },
        orderBy: { createdAt: "asc" },
      }),
    serviceAccounts: () =>
      tx.serviceAccount.findMany({
        where: saLive,
        select: { id: true, name: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    serviceAccountTokens: () =>
      tx.serviceAccountToken.findMany({
        where: saTokenLive,
        select: {
          id: true,
          name: true,
          prefix: true,
          serviceAccountId: true,
          serviceAccount: { select: { name: true } },
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
    mcpClients: () =>
      tx.mcpClient.findMany({
        where: mcpLive,
        select: { id: true, name: true, clientId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    breakglassGrants: () =>
      tx.personalLogAccessGrant.findMany({
        where: breakglassLive,
        select: { id: true, targetUserId: true, reason: true, effectiveAt: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    emergencyAccessGrants: async () => {
      const grants = await tx.emergencyAccessGrant.findMany({
        where: eaLive,
        select: { id: true, granteeEmail: true, status: true, encryptedSecretKey: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      // Whether the vault key is escrowed to the grantee, never the escrow.
      return grants.map(({ encryptedSecretKey, ...g }) => ({ ...g, hasEscrow: encryptedSecretKey !== null }));
    },
  };

  const createdFootholds: Partial<Record<FootholdKind, unknown[]>> = {};
  for (const kind of FOOTHOLD_KINDS) {
    if (mayContainKind(role, kind)) createdFootholds[kind] = await listers[kind]();
  }
  return {
    linkedAccounts: accounts.map(({ tenantId: linkedTenantId, ...a }) => ({
      ...a,
      linkedInTenant: linkedTenantId === tenantId,
    })),
    createdFootholds,
  };
}

// ─── Writes (C4) ──────────────────────────────────────────

export type ContainmentKind = "accounts" | FootholdKind;

/** Per kind the request named: rows written, and ids that matched nothing live of the member's. */
export type ContainedCounts = Partial<Record<ContainmentKind, { revoked: number; skipped: number }>>;

/** What a containment wrote under another tenant, for that tenant's own row. */
export interface OtherTenantContainment {
  accountsUnlinked: number;
  emergencyAccessGrantsRevoked: number;
}

export interface MemberContainmentResult {
  contained: ContainedCounts;
  unlinkedAccountIds: string[];
  /** Keyed by tenant id; never the admin's tenant. */
  otherTenants: Map<string, OtherTenantContainment>;
}

/**
 * Write a containment request in the caller's transaction, after the
 * passkey and session revocation: each named row only when it matches its id,
 * the member as creator or owner, the admin's tenant (tenant-owned kinds) and
 * liveness. Each write is a compare-and-set on that predicate; an id that
 * matches nothing is skipped and counted. Audited per row in the transaction.
 */
export async function containMemberInTx(
  tx: Prisma.TransactionClient,
  {
    req,
    actorUserId,
    tenantId,
    targetUserId,
    request,
    now = new Date(),
  }: {
    req: NextRequest;
    actorUserId: string;
    tenantId: string;
    targetUserId: string;
    request: MemberContainmentRequest;
    now?: Date;
  },
): Promise<MemberContainmentResult> {
  const scimLive = { tenantId, createdById: targetUserId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const saLive = { tenantId, createdById: targetUserId, isActive: true };
  const saTokenLive = { tenantId, createdById: targetUserId, revokedAt: null, expiresAt: { gt: now } };
  const mcpLive = { tenantId, createdById: targetUserId, isActive: true };
  const breakglassLive = { tenantId, requesterId: targetUserId, revokedAt: null, expiresAt: { gt: now } };
  const eaLive = { ownerId: targetUserId, status: { notIn: [EA_STATUS.REVOKED, EA_STATUS.REJECTED] } };
  const audit = (params: Required<Pick<AuditLogParams, "action" | "targetType" | "targetId" | "metadata">>) =>
    logAuditInTx(tx, tenantId, { ...tenantAuditBase(req, actorUserId, tenantId), ...params });
  const contained: ContainedCounts = {};
  const otherTenants = new Map<string, OtherTenantContainment>();
  const elsewhere = (other: string): OtherTenantContainment => {
    const entry = otherTenants.get(other) ?? { accountsUnlinked: 0, emergencyAccessGrantsRevoked: 0 };
    otherTenants.set(other, entry);
    return entry;
  };
  const count = (kind: ContainmentKind, requested: readonly string[], revoked: number) => {
    if (requested.length > 0) contained[kind] = { revoked, skipped: requested.length - revoked };
  };

  // Accounts: the user's, wherever filed (Account.tenantId is the tenant at
  // link time). No per-account row: the revoke-all row names them.
  const unlinkedAccountIds: string[] = [];
  if (request.unlinkAccountIds.length > 0) {
    const accounts = await tx.account.findMany({
      where: { id: { in: [...request.unlinkAccountIds] }, userId: targetUserId },
      select: { id: true, tenantId: true },
    });
    for (const account of accounts) {
      const { count: deleted } = await tx.account.deleteMany({ where: { id: account.id, userId: targetUserId } });
      if (deleted !== 1) continue;
      unlinkedAccountIds.push(account.id);
      if (account.tenantId !== tenantId) elsewhere(account.tenantId).accountsUnlinked += 1;
    }
  }
  count("accounts", request.unlinkAccountIds, unlinkedAccountIds.length);

  const scimIds = request.revoke.scimTokens;
  let scimRevoked = 0;
  if (scimIds.length > 0) {
    const tokens = await tx.scimToken.findMany({
      where: { id: { in: [...scimIds] }, ...scimLive },
      select: { id: true },
    });
    for (const token of tokens) {
      const { count: n } = await tx.scimToken.updateMany({
        where: { id: token.id, ...scimLive },
        data: { revokedAt: now },
      });
      if (n !== 1) continue;
      scimRevoked += 1;
      await audit({ action: AUDIT_ACTION.SCIM_TOKEN_REVOKE, targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN, targetId: token.id, metadata: { targetUserId } });
    }
  }
  count(FOOTHOLD_KIND.SCIM_TOKENS, scimIds, scimRevoked);

  // Service accounts: deactivated AND their live tokens revoked — stronger
  // than PUT isActive:false, so a later reactivation revives no token.
  const saIds = request.revoke.serviceAccounts;
  let saDeactivated = 0;
  if (saIds.length > 0) {
    const accounts = await tx.serviceAccount.findMany({
      where: { id: { in: [...saIds] }, ...saLive },
      select: { id: true },
    });
    for (const sa of accounts) {
      const { count: n } = await tx.serviceAccount.updateMany({
        where: { id: sa.id, ...saLive },
        data: { isActive: false },
      });
      if (n !== 1) continue;
      saDeactivated += 1;
      const { count: tokensRevoked } = await tx.serviceAccountToken.updateMany({
        where: { serviceAccountId: sa.id, tenantId, revokedAt: null },
        data: { revokedAt: now },
      });
      await audit({
        action: AUDIT_ACTION.SERVICE_ACCOUNT_UPDATE,
        targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT,
        targetId: sa.id,
        metadata: { isActive: false, tokensRevoked, targetUserId },
      });
    }
  }
  count(FOOTHOLD_KIND.SERVICE_ACCOUNTS, saIds, saDeactivated);

  // Tokens the member minted, on any service account of the tenant.
  const saTokenIds = request.revoke.serviceAccountTokens;
  let saTokensRevoked = 0;
  if (saTokenIds.length > 0) {
    const tokens = await tx.serviceAccountToken.findMany({
      where: { id: { in: [...saTokenIds] }, ...saTokenLive },
      select: { id: true, serviceAccountId: true },
    });
    for (const token of tokens) {
      const { count: n } = await tx.serviceAccountToken.updateMany({
        where: { id: token.id, ...saTokenLive },
        data: { revokedAt: now },
      });
      if (n !== 1) continue;
      saTokensRevoked += 1;
      await audit({
        action: AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_REVOKE,
        targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT_TOKEN,
        targetId: token.id,
        metadata: { serviceAccountId: token.serviceAccountId, targetUserId },
      });
    }
  }
  count(FOOTHOLD_KIND.SERVICE_ACCOUNT_TOKENS, saTokenIds, saTokensRevoked);

  // MCP clients: deactivated and their access and refresh tokens revoked.
  const mcpIds = request.revoke.mcpClients;
  let mcpDeactivated = 0;
  if (mcpIds.length > 0) {
    const clients = await tx.mcpClient.findMany({
      where: { id: { in: [...mcpIds] }, ...mcpLive },
      select: { id: true },
    });
    for (const client of clients) {
      const { count: n } = await tx.mcpClient.updateMany({
        where: { id: client.id, ...mcpLive },
        data: { isActive: false },
      });
      if (n !== 1) continue;
      mcpDeactivated += 1;
      const access = await tx.mcpAccessToken.updateMany({
        where: { clientId: client.id, tenantId, revokedAt: null },
        data: { revokedAt: now },
      });
      const refresh = await tx.mcpRefreshToken.updateMany({
        where: { clientId: client.id, tenantId, revokedAt: null },
        data: { revokedAt: now },
      });
      await audit({
        action: AUDIT_ACTION.MCP_CLIENT_UPDATE,
        targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
        targetId: client.id,
        metadata: { isActive: false, tokensRevoked: access.count + refresh.count, targetUserId },
      });
    }
  }
  count(FOOTHOLD_KIND.MCP_CLIENTS, mcpIds, mcpDeactivated);

  const breakglassIds = request.revoke.breakglassGrants;
  let breakglassRevoked = 0;
  if (breakglassIds.length > 0) {
    const grants = await tx.personalLogAccessGrant.findMany({
      where: { id: { in: [...breakglassIds] }, ...breakglassLive },
      select: { id: true, targetUserId: true },
    });
    for (const grant of grants) {
      const { count: n } = await tx.personalLogAccessGrant.updateMany({
        where: { id: grant.id, ...breakglassLive },
        data: { revokedAt: now },
      });
      if (n !== 1) continue;
      breakglassRevoked += 1;
      // The single revoke route's row, with the admin as the revoker.
      await audit({
        action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_REVOKE,
        targetType: "User",
        targetId: grant.targetUserId,
        metadata: { grantId: grant.id, requesterId: targetUserId, targetUserId: grant.targetUserId, revokedById: actorUserId },
      });
    }
  }
  count(FOOTHOLD_KIND.BREAKGLASS_GRANTS, breakglassIds, breakglassRevoked);

  // Last: the member's emergency-access grants, through the state machine's
  // single writer, clearing what the owner's permanent revoke clears. The
  // grantee is not told (the grantee may be the attacker). An ACTIVATED grant
  // stops serving the vault; a key already unwrapped cannot be taken back.
  const eaIds = request.revoke.emergencyAccessGrants;
  let eaRevoked = 0;
  if (eaIds.length > 0) {
    const grants = await tx.emergencyAccessGrant.findMany({
      where: { id: { in: [...eaIds] }, ...eaLive },
      select: { id: true, tenantId: true, granteeId: true },
    });
    for (const grant of grants) {
      const result = await transition({
        db: tx,
        where: { id: grant.id, ownerId: targetUserId },
        to: EA_STATUS.REVOKED,
        actor: EA_ACTOR.OWNER,
        extraData: {
          revokedAt: now,
          encryptedSecretKey: null,
          secretKeyIv: null,
          secretKeyAuthTag: null,
          ownerEphemeralPublicKey: null,
          hkdfSalt: null,
        },
      });
      if (!result.ok) continue;
      eaRevoked += 1;
      if (grant.tenantId !== tenantId) elsewhere(grant.tenantId).emergencyAccessGrantsRevoked += 1;
      await audit({
        action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE,
        targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
        targetId: grant.id,
        metadata: { ownerId: targetUserId, granteeId: grant.granteeId, permanent: true, revokedById: actorUserId },
      });
    }
  }
  count(FOOTHOLD_KIND.EMERGENCY_ACCESS_GRANTS, eaIds, eaRevoked);

  return { contained, unlinkedAccountIds, otherTenants };
}
