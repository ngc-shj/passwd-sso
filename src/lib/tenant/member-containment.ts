import type { NextRequest } from "next/server";
import type { Prisma, TenantRole } from "@prisma/client";
import { logAuditBulkInTx, tenantAuditBase } from "@/lib/audit/audit";
import type { AuditLogParams } from "@/lib/audit/audit-payload";
import { hasTenantPermission, type TenantPermission } from "@/lib/auth/access/tenant-permissions";
import { transition } from "@/lib/emergency-access/emergency-access-state";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, EA_ACTOR, EA_STATUS, SHARE_TYPE, TENANT_ROLE } from "@/lib/constants";
import { maskUrlForDisplay } from "@/lib/url/url-validation";
import { deliveryTargetEndpoint } from "@/lib/audit/audit-delivery-target-endpoint";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { MEMBER_CONTAINMENT_MAX_IDS, type MemberContainmentInput } from "@/lib/validations/member-containment";

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
  TENANT_WEBHOOKS: "tenantWebhooks",
  VAULT_RESETS: "vaultResets",
  SHARE_LINKS: "shareLinks",
  AUDIT_DELIVERY_TARGETS: "auditDeliveryTargets",
  EMERGENCY_ACCESS_GRANTS: "emergencyAccessGrants",
} as const;

export type FootholdKind = (typeof FOOTHOLD_KIND)[keyof typeof FOOTHOLD_KIND];

/** In the pinned write order: emergency-access grants last. */
const FOOTHOLD_KINDS: readonly FootholdKind[] = Object.values(FOOTHOLD_KIND);

/** The Prisma model delegate each kind's rows live in. */
export const FOOTHOLD_MODEL: Record<FootholdKind, string> = {
  scimTokens: "scimToken",
  serviceAccounts: "serviceAccount",
  serviceAccountTokens: "serviceAccountToken",
  mcpClients: "mcpClient",
  breakglassGrants: "personalLogAccessGrant",
  tenantWebhooks: "tenantWebhook",
  vaultResets: "adminVaultReset",
  shareLinks: "passwordShare",
  auditDeliveryTargets: "auditDeliveryTarget",
  emergencyAccessGrants: "emergencyAccessGrant",
};

// What managing each kind takes outside this flow. MEMBER_MANAGE (which the
// route already requires) is the gate; these are defence in depth — OWNER and
// ADMIN hold all of them today. An emergency-access grant and a share link are
// the member's own, with no tenant permission of their own.
const KIND_PERMISSION: Record<FootholdKind, TenantPermission | null> = {
  scimTokens: TENANT_PERMISSION.SCIM_MANAGE,
  serviceAccounts: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
  serviceAccountTokens: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
  mcpClients: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
  breakglassGrants: TENANT_PERMISSION.BREAKGLASS_REQUEST,
  tenantWebhooks: TENANT_PERMISSION.WEBHOOK_MANAGE,
  vaultResets: TENANT_PERMISSION.MEMBER_VAULT_RESET,
  shareLinks: null,
  auditDeliveryTargets: TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE,
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
      tenantWebhooks: unique(revoke.tenantWebhookIds),
      vaultResets: unique(revoke.vaultResetIds),
      shareLinks: unique(revoke.shareLinkIds),
      auditDeliveryTargets: unique(revoke.auditDeliveryTargetIds),
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
// - Tenant webhook: the admin's tenant, created by the member.
// - Vault reset: the admin's tenant, initiated by the member, not yet
//   approved, executed or revoked, not expired.
// - Share link / Send: the admin's tenant, created by the member (personal
//   and team links and Sends alike), not revoked, not expired, views not
//   exhausted. The exhausted clause compares two columns, so it names the
//   field through tx.passwordShare.fields.
// - Audit delivery target: the admin's tenant, created by the member, active.
// - Emergency-access grant: the member's own, in whichever tenant it was
//   filed under, not revoked or rejected.

// ─── Listing (C3) ─────────────────────────────────────────

export interface MemberContainmentListing {
  /** Never providerAccountId or any token: not needed to choose an unlink. */
  linkedAccounts: { id: string; provider: string; linkedHere: boolean }[];
  /** Only the kinds the actor may contain. */
  createdFootholds: Partial<Record<FootholdKind, unknown[]>>;
  /**
   * Per kind the actor may contain whose listing is cut at
   * MEMBER_CONTAINMENT_MAX_IDS: how many more live rows exist than are listed.
   * A kind that fits has no key.
   */
  moreFootholds: Partial<Record<FootholdKind, number>>;
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
  const webhookLive = { tenantId, createdById: targetUserId };
  const resetLive = { tenantId, initiatedById: targetUserId, approvedAt: null, executedAt: null, revokedAt: null, expiresAt: { gt: now } };
  const shareLive = {
    tenantId,
    createdById: targetUserId,
    revokedAt: null,
    expiresAt: { gt: now },
    OR: [{ maxViews: null }, { viewCount: { lt: tx.passwordShare.fields.maxViews } }],
  };
  const targetLive = { tenantId, createdById: targetUserId, isActive: true };
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
        take: MEMBER_CONTAINMENT_MAX_IDS,
      }),
    serviceAccounts: () =>
      tx.serviceAccount.findMany({
        where: saLive,
        select: { id: true, name: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
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
        take: MEMBER_CONTAINMENT_MAX_IDS,
      }),
    mcpClients: () =>
      tx.mcpClient.findMany({
        where: mcpLive,
        select: { id: true, name: true, clientId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
      }),
    breakglassGrants: () =>
      tx.personalLogAccessGrant.findMany({
        where: breakglassLive,
        select: { id: true, targetUserId: true, reason: true, effectiveAt: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
      }),
    tenantWebhooks: () =>
      tx.tenantWebhook.findMany({
        where: webhookLive,
        select: { id: true, url: true, isActive: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
      }),
    vaultResets: () =>
      tx.adminVaultReset.findMany({
        where: resetLive,
        select: {
          id: true,
          targetUserId: true,
          targetUser: { select: { name: true, email: true } },
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
      }),
    shareLinks: async () => {
      const shares = await tx.passwordShare.findMany({
        where: shareLive,
        select: { id: true, shareType: true, teamPasswordEntryId: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
      });
      return shares.map(({ teamPasswordEntryId, ...share }) => ({ ...share, isTeam: teamPasswordEntryId !== null }));
    },
    auditDeliveryTargets: async () => {
      const targets = await tx.auditDeliveryTarget.findMany({
        where: targetLive,
        select: {
          id: true,
          kind: true,
          createdAt: true,
          configEncrypted: true,
          configIv: true,
          configAuthTag: true,
          masterKeyVersion: true,
        },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
      });
      // The masked destination only, never the encrypted config.
      return targets.map((target) => ({
        id: target.id,
        kind: target.kind,
        endpoint: deliveryTargetEndpoint(target, tenantId),
        createdAt: target.createdAt,
      }));
    },
    emergencyAccessGrants: async () => {
      const grants = await tx.emergencyAccessGrant.findMany({
        where: eaLive,
        select: { id: true, granteeEmail: true, status: true, encryptedSecretKey: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: MEMBER_CONTAINMENT_MAX_IDS,
      });
      // Whether the vault key is escrowed to the grantee, never the escrow.
      return grants.map(({ encryptedSecretKey, ...g }) => ({ ...g, hasEscrow: encryptedSecretKey !== null }));
    },
  };

  // How many live rows each kind has: asked only of a kind whose listing
  // reached the cut, to say how many it left out.
  const counters: Record<FootholdKind, () => Promise<number>> = {
    scimTokens: () => tx.scimToken.count({ where: scimLive }),
    serviceAccounts: () => tx.serviceAccount.count({ where: saLive }),
    serviceAccountTokens: () => tx.serviceAccountToken.count({ where: saTokenLive }),
    mcpClients: () => tx.mcpClient.count({ where: mcpLive }),
    breakglassGrants: () => tx.personalLogAccessGrant.count({ where: breakglassLive }),
    tenantWebhooks: () => tx.tenantWebhook.count({ where: webhookLive }),
    vaultResets: () => tx.adminVaultReset.count({ where: resetLive }),
    shareLinks: () => tx.passwordShare.count({ where: shareLive }),
    auditDeliveryTargets: () => tx.auditDeliveryTarget.count({ where: targetLive }),
    emergencyAccessGrants: () => tx.emergencyAccessGrant.count({ where: eaLive }),
  };

  const createdFootholds: Partial<Record<FootholdKind, unknown[]>> = {};
  const moreFootholds: Partial<Record<FootholdKind, number>> = {};
  for (const kind of FOOTHOLD_KINDS) {
    if (!mayContainKind(role, kind)) continue;
    const rows = await listers[kind]();
    createdFootholds[kind] = rows;
    if (rows.length < MEMBER_CONTAINMENT_MAX_IDS) continue;
    const more = (await counters[kind]()) - rows.length;
    if (more > 0) moreFootholds[kind] = more;
  }
  return {
    linkedAccounts: accounts.map(({ tenantId: linkedTenantId, ...a }) => ({
      ...a,
      linkedHere: linkedTenantId === tenantId,
    })),
    createdFootholds,
    moreFootholds,
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
  /**
   * Per kind the actor may contain, the member's live rows once the writes are
   * done: what the request did not name, or could not write. Zero kinds are
   * kept, so a kind the actor may contain is distinguishable from one it may not.
   */
  remaining: Partial<Record<FootholdKind, number>>;
  unlinkedAccountIds: string[];
  /** Keyed by tenant id; never the admin's tenant. */
  otherTenants: Map<string, OtherTenantContainment>;
}

/** How many times each id occurs. */
function tally(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/**
 * Write a containment request in the caller's transaction, after the
 * passkey and session revocation: each named row only when it matches its id,
 * the member as creator or owner, the admin's tenant (tenant-owned kinds) and
 * liveness. One compare-and-set statement per kind on that predicate (the
 * emergency-access grants one by one through the state machine), so the work
 * is bounded by the number of kinds, not of rows: the rows it returns are the
 * rows written, counted and audited; an id that matches nothing is skipped and
 * counted. Audited per row, in one batch per kind, in the transaction.
 */
export async function containMemberInTx(
  tx: Prisma.TransactionClient,
  {
    req,
    actorUserId,
    tenantId,
    targetUserId,
    request,
    role,
    now = new Date(),
  }: {
    req: NextRequest;
    actorUserId: string;
    tenantId: string;
    targetUserId: string;
    request: MemberContainmentRequest;
    role: TenantRole;
    now?: Date;
  },
): Promise<MemberContainmentResult> {
  const scimLive = { tenantId, createdById: targetUserId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
  const saLive = { tenantId, createdById: targetUserId, isActive: true };
  const saTokenLive = { tenantId, createdById: targetUserId, revokedAt: null, expiresAt: { gt: now } };
  const mcpLive = { tenantId, createdById: targetUserId, isActive: true };
  const breakglassLive = { tenantId, requesterId: targetUserId, revokedAt: null, expiresAt: { gt: now } };
  const webhookLive = { tenantId, createdById: targetUserId };
  const resetLive = { tenantId, initiatedById: targetUserId, approvedAt: null, executedAt: null, revokedAt: null, expiresAt: { gt: now } };
  const shareLive = {
    tenantId,
    createdById: targetUserId,
    revokedAt: null,
    expiresAt: { gt: now },
    OR: [{ maxViews: null }, { viewCount: { lt: tx.passwordShare.fields.maxViews } }],
  };
  const targetLive = { tenantId, createdById: targetUserId, isActive: true };
  const eaLive = { ownerId: targetUserId, status: { notIn: [EA_STATUS.REVOKED, EA_STATUS.REJECTED] } };
  const base = tenantAuditBase(req, actorUserId, tenantId);
  const audit = (rows: (Required<Pick<AuditLogParams, "action" | "metadata">> & Pick<AuditLogParams, "targetType" | "targetId">)[]) =>
    logAuditBulkInTx(tx, tenantId, rows.map((params) => ({ ...base, ...params })));
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
  // link time). A delete returns no rows, so the rows are read on the same
  // predicate and the delete must remove exactly them: anything else (an
  // unlink committed meanwhile) rolls the containment back for a retry rather
  // than miscount another tenant's share. No per-account row: the revoke-all
  // row names them.
  const unlinkedAccountIds: string[] = [];
  if (request.unlinkAccountIds.length > 0) {
    const accounts = await tx.account.findMany({
      where: { id: { in: [...request.unlinkAccountIds] }, userId: targetUserId },
      select: { id: true, tenantId: true },
    });
    if (accounts.length > 0) {
      const { count: deleted } = await tx.account.deleteMany({
        where: { id: { in: accounts.map((a) => a.id) }, userId: targetUserId },
      });
      if (deleted !== accounts.length) {
        throw new Error(`member containment: ${deleted} of ${accounts.length} accounts read were deleted`);
      }
    }
    for (const account of accounts) {
      unlinkedAccountIds.push(account.id);
      if (account.tenantId !== tenantId) elsewhere(account.tenantId).accountsUnlinked += 1;
    }
  }
  count("accounts", request.unlinkAccountIds, unlinkedAccountIds.length);

  const scimIds = request.revoke.scimTokens;
  if (scimIds.length > 0) {
    const revoked = await tx.scimToken.updateManyAndReturn({
      where: { id: { in: [...scimIds] }, ...scimLive },
      data: { revokedAt: now },
      select: { id: true },
    });
    await audit(revoked.map((token) => ({
      action: AUDIT_ACTION.SCIM_TOKEN_REVOKE,
      targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
      targetId: token.id,
      metadata: { targetUserId },
    })));
    count(FOOTHOLD_KIND.SCIM_TOKENS, scimIds, revoked.length);
  }

  // Service accounts: deactivated AND their live tokens revoked — stronger
  // than PUT isActive:false, so a later reactivation revives no token. The
  // tokens are found by the service accounts this statement deactivated,
  // never by the ids the request named.
  const saIds = request.revoke.serviceAccounts;
  // Tokens revoked with their service account, for the token step below.
  const revokedWithServiceAccount = new Map<string, { serviceAccountId: string; createdById: string | null; expiresAt: Date }>();
  if (saIds.length > 0) {
    const deactivated = await tx.serviceAccount.updateManyAndReturn({
      where: { id: { in: [...saIds] }, ...saLive },
      data: { isActive: false },
      select: { id: true },
    });
    const tokens = deactivated.length > 0
      ? await tx.serviceAccountToken.updateManyAndReturn({
          where: { serviceAccountId: { in: deactivated.map((sa) => sa.id) }, tenantId, revokedAt: null },
          data: { revokedAt: now },
          select: { id: true, serviceAccountId: true, createdById: true, expiresAt: true },
        })
      : [];
    for (const { id, ...token } of tokens) revokedWithServiceAccount.set(id, token);
    const tokensRevoked = tally(tokens.map((t) => t.serviceAccountId));
    await audit(deactivated.map((sa) => ({
      action: AUDIT_ACTION.SERVICE_ACCOUNT_UPDATE,
      targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT,
      targetId: sa.id,
      metadata: { isActive: false, tokensRevoked: tokensRevoked.get(sa.id) ?? 0, targetUserId },
    })));
    count(FOOTHOLD_KIND.SERVICE_ACCOUNTS, saIds, deactivated.length);
  }

  // Tokens the member minted, on any service account of the tenant. A named
  // token the step above already revoked with its service account is
  // contained too when it was live and the member's: it gets its own row,
  // marked, so the kind's count and its rows agree.
  const saTokenIds = request.revoke.serviceAccountTokens;
  if (saTokenIds.length > 0) {
    const revoked = await tx.serviceAccountToken.updateManyAndReturn({
      where: { id: { in: [...saTokenIds] }, ...saTokenLive },
      data: { revokedAt: now },
      select: { id: true, serviceAccountId: true },
    });
    const withServiceAccount = saTokenIds.flatMap((id) => {
      const token = revokedWithServiceAccount.get(id);
      return token && token.createdById === targetUserId && token.expiresAt > now
        ? [{ id, serviceAccountId: token.serviceAccountId }]
        : [];
    });
    await audit([
      ...revoked.map((token) => ({
        action: AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_REVOKE,
        targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT_TOKEN,
        targetId: token.id,
        metadata: { serviceAccountId: token.serviceAccountId, targetUserId },
      })),
      ...withServiceAccount.map((token) => ({
        action: AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_REVOKE,
        targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT_TOKEN,
        targetId: token.id,
        metadata: { serviceAccountId: token.serviceAccountId, targetUserId, revokedWithServiceAccount: true },
      })),
    ]);
    count(FOOTHOLD_KIND.SERVICE_ACCOUNT_TOKENS, saTokenIds, revoked.length + withServiceAccount.length);
  }

  // MCP clients: deactivated and their access and refresh tokens revoked,
  // found by the clients this statement deactivated.
  const mcpIds = request.revoke.mcpClients;
  if (mcpIds.length > 0) {
    const deactivated = await tx.mcpClient.updateManyAndReturn({
      where: { id: { in: [...mcpIds] }, ...mcpLive },
      data: { isActive: false },
      select: { id: true },
    });
    const clientIds = deactivated.map((client) => client.id);
    const access = clientIds.length > 0
      ? await tx.mcpAccessToken.updateManyAndReturn({
          where: { clientId: { in: clientIds }, tenantId, revokedAt: null },
          data: { revokedAt: now },
          select: { clientId: true },
        })
      : [];
    const refresh = clientIds.length > 0
      ? await tx.mcpRefreshToken.updateManyAndReturn({
          where: { clientId: { in: clientIds }, tenantId, revokedAt: null },
          data: { revokedAt: now },
          select: { clientId: true },
        })
      : [];
    const tokensRevoked = tally([...access, ...refresh].map((t) => t.clientId));
    await audit(deactivated.map((client) => ({
      action: AUDIT_ACTION.MCP_CLIENT_UPDATE,
      targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
      targetId: client.id,
      metadata: { isActive: false, tokensRevoked: tokensRevoked.get(client.id) ?? 0, targetUserId },
    })));
    count(FOOTHOLD_KIND.MCP_CLIENTS, mcpIds, deactivated.length);
  }

  const breakglassIds = request.revoke.breakglassGrants;
  if (breakglassIds.length > 0) {
    const revoked = await tx.personalLogAccessGrant.updateManyAndReturn({
      where: { id: { in: [...breakglassIds] }, ...breakglassLive },
      data: { revokedAt: now },
      select: { id: true, targetUserId: true },
    });
    // The single revoke route's row, with the admin as the revoker.
    await audit(revoked.map((grant) => ({
      action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_REVOKE,
      targetType: "User",
      targetId: grant.targetUserId,
      metadata: { grantId: grant.id, requesterId: targetUserId, targetUserId: grant.targetUserId, revokedById: actorUserId },
    })));
    count(FOOTHOLD_KIND.BREAKGLASS_GRANTS, breakglassIds, revoked.length);
  }

  // Webhooks: read on the predicate, then deleted by exactly those ids (a
  // delete returns no rows), as the accounts step: a count that differs means
  // one went meanwhile and rolls the containment back for a retry rather than
  // audit a row it did not delete.
  const webhookIds = request.revoke.tenantWebhooks;
  if (webhookIds.length > 0) {
    const webhooks = await tx.tenantWebhook.findMany({
      where: { id: { in: [...webhookIds] }, ...webhookLive },
      select: { id: true, url: true },
    });
    if (webhooks.length > 0) {
      const { count: deleted } = await tx.tenantWebhook.deleteMany({
        where: { id: { in: webhooks.map((w) => w.id) }, ...webhookLive },
      });
      if (deleted !== webhooks.length) {
        throw new Error(`member containment: ${deleted} of ${webhooks.length} webhooks read were deleted`);
      }
    }
    await audit(webhooks.map((webhook) => ({
      action: AUDIT_ACTION.TENANT_WEBHOOK_DELETE,
      metadata: { webhookId: webhook.id, url: maskUrlForDisplay(webhook.url), targetUserId },
    })));
    count(FOOTHOLD_KIND.TENANT_WEBHOOKS, webhookIds, webhooks.length);
  }

  // Resets the member initiated that nobody approved: revoked, the token
  // cleared. The target is not told — an unapproved reset was never announced.
  const resetIds = request.revoke.vaultResets;
  if (resetIds.length > 0) {
    const revoked = await tx.adminVaultReset.updateManyAndReturn({
      where: { id: { in: [...resetIds] }, ...resetLive },
      data: { revokedAt: now, encryptedToken: null },
      select: { id: true, targetUserId: true },
    });
    await audit(revoked.map((reset) => ({
      action: AUDIT_ACTION.ADMIN_VAULT_RESET_REVOKE,
      targetType: "User",
      targetId: reset.targetUserId,
      metadata: { resetId: reset.id, initiatedById: targetUserId, revokedById: actorUserId },
    })));
    count(FOOTHOLD_KIND.VAULT_RESETS, resetIds, revoked.length);
  }

  // Share links and Sends: revoked (never deleted — the access logs and the
  // revoke row name the share). One row per share, in the single revoke
  // route's actions, here at TENANT scope with the admin as the revoker.
  const shareIds = request.revoke.shareLinks;
  if (shareIds.length > 0) {
    const revoked = await tx.passwordShare.updateManyAndReturn({
      where: { id: { in: [...shareIds] }, ...shareLive },
      data: { revokedAt: now },
      select: { id: true, shareType: true },
    });
    await audit(revoked.map((share) => ({
      action: share.shareType === SHARE_TYPE.ENTRY_SHARE ? AUDIT_ACTION.SHARE_REVOKE : AUDIT_ACTION.SEND_REVOKE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
      metadata: { targetUserId, revokedById: actorUserId },
    })));
    count(FOOTHOLD_KIND.SHARE_LINKS, shareIds, revoked.length);
  }

  // Delivery targets: deactivated, not deleted (deliveries hold a Restrict FK).
  // The queued backlog stops being claimed once the target is inactive.
  const targetIds = request.revoke.auditDeliveryTargets;
  if (targetIds.length > 0) {
    const deactivated = await tx.auditDeliveryTarget.updateManyAndReturn({
      where: { id: { in: [...targetIds] }, ...targetLive },
      data: { isActive: false },
      select: { id: true, kind: true },
    });
    await audit(deactivated.map((target) => ({
      action: AUDIT_ACTION.AUDIT_DELIVERY_TARGET_DEACTIVATE,
      metadata: { targetId: target.id, kind: target.kind, targetUserId },
    })));
    count(FOOTHOLD_KIND.AUDIT_DELIVERY_TARGETS, targetIds, deactivated.length);
  }

  // Last: the member's emergency-access grants, through the state machine's
  // single writer, clearing what the owner's permanent revoke clears — one by
  // one (at most MEMBER_CONTAINMENT_MAX_IDS), as transition() writes a single
  // row. The grantee is not told (the grantee may be the attacker). An
  // ACTIVATED grant stops serving the vault; a key already unwrapped cannot be
  // taken back.
  const eaIds = request.revoke.emergencyAccessGrants;
  if (eaIds.length > 0) {
    const grants = await tx.emergencyAccessGrant.findMany({
      where: { id: { in: [...eaIds] }, ...eaLive },
      select: { id: true, tenantId: true, granteeId: true },
    });
    const revoked: typeof grants = [];
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
      revoked.push(grant);
      if (grant.tenantId !== tenantId) elsewhere(grant.tenantId).emergencyAccessGrantsRevoked += 1;
    }
    await audit(revoked.map((grant) => ({
      action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE,
      targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
      targetId: grant.id,
      metadata: { ownerId: targetUserId, granteeId: grant.granteeId, permanent: true, revokedById: actorUserId },
    })));
    count(FOOTHOLD_KIND.EMERGENCY_ACCESS_GRANTS, eaIds, revoked.length);
  }

  // What is still live after the writes, in the same transaction under the
  // same credential lock: no timestamp baseline, so no clock skew and no gap
  // between the claim and the count. Counts rows the request did not select.
  const counters: Record<FootholdKind, () => Promise<number>> = {
    scimTokens: () => tx.scimToken.count({ where: scimLive }),
    serviceAccounts: () => tx.serviceAccount.count({ where: saLive }),
    serviceAccountTokens: () => tx.serviceAccountToken.count({ where: saTokenLive }),
    mcpClients: () => tx.mcpClient.count({ where: mcpLive }),
    breakglassGrants: () => tx.personalLogAccessGrant.count({ where: breakglassLive }),
    tenantWebhooks: () => tx.tenantWebhook.count({ where: webhookLive }),
    vaultResets: () => tx.adminVaultReset.count({ where: resetLive }),
    shareLinks: () => tx.passwordShare.count({ where: shareLive }),
    auditDeliveryTargets: () => tx.auditDeliveryTarget.count({ where: targetLive }),
    emergencyAccessGrants: () => tx.emergencyAccessGrant.count({ where: eaLive }),
  };
  const remaining: Partial<Record<FootholdKind, number>> = {};
  for (const kind of FOOTHOLD_KINDS) {
    if (mayContainKind(role, kind)) remaining[kind] = await counters[kind]();
  }

  return { contained, remaining, unlinkedAccountIds, otherTenants };
}
