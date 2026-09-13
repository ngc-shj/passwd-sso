/**
 * Directory Sync orchestration engine.
 *
 * Fetches users from the configured IdP provider, diffs against
 * existing ScimExternalMapping / TenantMember records, and applies
 * create / update / deactivate operations.
 *
 * Safety: if deactivations > 20% of active users and force is not set,
 * the sync is aborted to prevent accidental mass-deactivation.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { resolveExistingUsersForTenant, usersActiveInAnotherTenant } from "@/lib/tenant-context";
import { realignAfterActivation } from "@/lib/tenant/tenant-realignment";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
import { logAuditAsync, logAuditBulkAsync } from "@/lib/audit/audit";
import { dispatchTenantWebhook } from "@/lib/webhook-dispatcher";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, TENANT_ROLE } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { resolveAuditUserId } from "@/lib/constants/app";
import { decryptCredentials } from "./credentials";
import { sanitizeSyncError } from "./sanitize";

// Provider clients
import {
  getAzureAdToken,
  fetchAzureAdUsers,
  type AzureAdCredentials,
} from "./azure-ad";
import {
  getGoogleAccessToken,
  fetchGoogleUsers,
  type GoogleCredentials,
} from "./google-workspace";
import {
  fetchOktaUsers,
  type OktaCredentials,
} from "./okta";

// ─── Types ───────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  dryRun: boolean;
  usersCreated: number;
  usersUpdated: number;
  usersDeactivated: number;
  /**
   * Activations the cross-tenant guard declined. Counted apart from the verbs
   * above, which report the writes that DID happen: a refused reactivation still
   * stamps `lastScimSyncedAt`, so without this a run that left the user
   * deactivated reported as `usersUpdated: 1, SUCCESS` and the IdP admin saw a
   * sync that worked.
   */
  usersRefused: number;
  groupsUpdated: number;
  errorMessage?: string;
  abortedSafety?: boolean;
  logId?: string;
}

/** Why an activation or an attachment was declined, recorded on its audit row. */
const REFUSAL_REASON = {
  /** The user holds an active membership in another tenant. */
  ACTIVE_IN_ANOTHER_TENANT: "active_in_another_tenant",
  /** The user is owned by another tenant and has no membership here. */
  OWNED_BY_ANOTHER_TENANT: "owned_by_another_tenant",
  /** Several existing users share the provider's email under different casing. */
  AMBIGUOUS_EMAIL: "ambiguous_email",
} as const;

type RefusalReason = (typeof REFUSAL_REASON)[keyof typeof REFUSAL_REASON];

interface ProviderUser {
  externalId: string;
  email: string;
  displayName: string;
  active: boolean;
}

interface SyncOptions {
  configId: string;
  tenantId: string;
  userId?: string;
  dryRun?: boolean;
  force?: boolean;
}

/** Maximum time a RUNNING status is considered valid before it is stale. */
const STALE_LOCK_MINUTES = 30;

/** Safety threshold: abort if deactivations exceed this fraction of active users. */
const SAFETY_THRESHOLD = 0.2;

// ─── Helpers ─────────────────────────────────────────────────

/** Write sanitized error to the sync config (never throws). */
async function writeSyncError(
  configId: string,
  tenantId: string,
  error: unknown,
): Promise<void> {
  try {
    await withTenantRls(prisma, tenantId, (tx) =>
      tx.directorySyncConfig.update({
        where: { id: configId, tenantId },
        data: {
          status: "ERROR",
          lastSyncError: sanitizeSyncError(error),
          lastSyncAt: new Date(),
        },
      }),
    );
  } catch {
    // best-effort
  }
}

// ─── Provider Fetch ──────────────────────────────────────────

async function fetchProviderUsers(
  provider: string,
  credentialsJson: string,
): Promise<ProviderUser[]> {
  switch (provider) {
    case "AZURE_AD": {
      const creds = JSON.parse(credentialsJson) as AzureAdCredentials;
      const token = await getAzureAdToken(
        creds.tenantId,
        creds.clientId,
        creds.clientSecret,
      );
      const users = await fetchAzureAdUsers(token);
      return users.map((u) => ({
        externalId: u.id,
        email: u.mail ?? "",
        displayName: u.displayName,
        active: u.accountEnabled,
      }));
    }

    case "GOOGLE_WORKSPACE": {
      const creds = JSON.parse(credentialsJson) as GoogleCredentials;
      const token = await getGoogleAccessToken(
        creds.serviceAccount,
        creds.domain,
        creds.adminEmail,
      );
      const users = await fetchGoogleUsers(token, creds.domain);
      return users.map((u) => ({
        externalId: u.id,
        email: u.primaryEmail,
        displayName: u.name.fullName,
        active: !u.suspended,
      }));
    }

    case "OKTA": {
      const creds = JSON.parse(credentialsJson) as OktaCredentials;
      const users = await fetchOktaUsers(creds.orgUrl, creds.apiToken);
      return users.map((u) => ({
        externalId: u.id,
        email: u.profile.email,
        displayName:
          u.profile.displayName ??
          `${u.profile.firstName} ${u.profile.lastName}`,
        active: u.status === "ACTIVE",
      }));
    }

    default:
      throw new Error(`Unsupported directory sync provider: ${provider}`);
  }
}

// ─── Core Engine ─────────────────────────────────────────────

export async function runDirectorySync(
  options: SyncOptions,
): Promise<SyncResult> {
  const { configId, tenantId, userId: actorUserId, dryRun = false, force = false } = options;
  const startedAt = new Date();

  // 1. CAS lock: atomically claim the config for sync
  let acquired: boolean;
  try {
    const staleThreshold = new Date(
      Date.now() - STALE_LOCK_MINUTES * MS_PER_MINUTE,
    );

    // Check for stale RUNNING state before CAS to detect stale-reset
    const preCheck = await withTenantRls(prisma, tenantId, (tx) =>
      tx.directorySyncConfig.findFirst({
        where: { id: configId, tenantId },
        select: { status: true, lastSyncAt: true },
      }),
    );
    const wasStaleRunning =
      preCheck?.status === "RUNNING" &&
      preCheck.lastSyncAt &&
      preCheck.lastSyncAt < staleThreshold;

    const updated = await withTenantRls(prisma, tenantId, (tx) =>
      tx.$executeRaw`
        UPDATE "directory_sync_configs"
        SET status = 'RUNNING'::"DirectorySyncStatus",
            "last_sync_at" = ${startedAt}
        WHERE id = ${configId}
          AND "tenant_id" = ${tenantId}
          AND (
            status = 'IDLE'::"DirectorySyncStatus"
            OR status = 'SUCCESS'::"DirectorySyncStatus"
            OR status = 'ERROR'::"DirectorySyncStatus"
            OR (
              status = 'RUNNING'::"DirectorySyncStatus"
              AND "last_sync_at" < ${staleThreshold}
            )
          )
      `,
    );
    acquired = updated > 0;

    // Log stale-reset if we overrode a stale RUNNING lock
    if (acquired && wasStaleRunning) {
      await logAuditAsync({
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.DIRECTORY_SYNC_STALE_RESET,
        userId: resolveAuditUserId(actorUserId, "system"),
        actorType: actorUserId ? ACTOR_TYPE.HUMAN : ACTOR_TYPE.SYSTEM,
        tenantId,
        targetType: AUDIT_TARGET_TYPE.DIRECTORY_SYNC_CONFIG,
        targetId: configId,
        metadata: { staleSince: preCheck.lastSyncAt },
      });
      void dispatchTenantWebhook({
        type: AUDIT_ACTION.DIRECTORY_SYNC_STALE_RESET,
        tenantId,
        timestamp: new Date().toISOString(),
        data: { configId },
      });
    }
  } catch (err) {
    return {
      success: false,
      dryRun,
      usersCreated: 0,
      usersUpdated: 0,
      usersDeactivated: 0,
      usersRefused: 0,
      groupsUpdated: 0,
      errorMessage: sanitizeSyncError(err),
    };
  }

  if (!acquired) {
    return {
      success: false,
      dryRun,
      usersCreated: 0,
      usersUpdated: 0,
      usersDeactivated: 0,
      usersRefused: 0,
      groupsUpdated: 0,
      errorMessage: "Sync already running (locked)",
    };
  }

  let usersCreated = 0;
  let usersUpdated = 0;
  let usersDeactivated = 0;
  let usersRefused = 0;
  const groupsUpdated = 0;

  /**
   * One entry per declined activation, emitted after the transaction commits.
   * Collected rather than emitted inline because the enqueue is a second
   * transaction and the sync's own is already long.
   *
   * Deliberately carries no identifier of the tenant the user is active in: the
   * audit trail is readable by THIS tenant's admins, and which other
   * organization holds the member is not theirs to learn.
   */
  const refusals: Array<{
    memberId: string | null;
    userId: string | null;
    email: string | null;
    reason: RefusalReason;
  }> = [];

  try {
    // 2. Load config and decrypt credentials
    const config = await withTenantRls(prisma, tenantId, (tx) =>
      tx.directorySyncConfig.findUnique({
        where: { id: configId },
        select: {
          provider: true,
          encryptedCredentials: true,
          credentialsIv: true,
          credentialsAuthTag: true,
          syncIntervalMinutes: true,
        },
      }),
    );

    if (!config) {
      throw new Error("Directory sync config not found");
    }

    const credentialsJson = decryptCredentials(
      {
        ciphertext: config.encryptedCredentials,
        iv: config.credentialsIv,
        authTag: config.credentialsAuthTag,
      },
      configId,
      tenantId,
    );

    // 3. Fetch users from IdP
    const providerUsers = await fetchProviderUsers(
      config.provider,
      credentialsJson,
    );

    // Filter out users without email
    const validUsers = providerUsers.filter((u) => u.email);

    // 4. Load existing mappings and members
    const [existingMappings, existingMembers, visibleUsers] = await withTenantRls(
      prisma,
      tenantId,
      async (tx) => {
        const [mappings, members] = await Promise.all([
          tx.scimExternalMapping.findMany({
            where: { tenantId, resourceType: "User" },
            select: { externalId: true, internalId: true },
          }),
          tx.tenantMember.findMany({
            where: { tenantId },
            select: { id: true, userId: true, deactivatedAt: true, role: true },
          }),
        ]);
        // The users this context can see, and so can write. Not a relation on the
        // member read: a member whose users row names another tenant came back
        // with `user: null` (measured: Prisma does not throw), and reading its
        // name in the diff below failed the whole run.
        const users = await tx.user.findMany({
          where: { id: { in: members.map((m) => m.userId) } },
          select: { id: true, name: true },
        });
        return [mappings, members, users] as const;
      },
    );

    const extIdToInternal = new Map(
      existingMappings.map((m) => [m.externalId, m.internalId]),
    );
    const memberByUserId = new Map(
      existingMembers.map((m) => [m.userId, m]),
    );
    const visibleNameByUserId = new Map(visibleUsers.map((u) => [u.id, u.name]));

    // 5. Diff
    const toCreate: ProviderUser[] = [];
    const toUpdate: Array<{ user: ProviderUser; internalId: string }> = [];
    const seenExternalIds = new Set<string>();

    for (const pu of validUsers) {
      seenExternalIds.add(pu.externalId);
      const internalId = extIdToInternal.get(pu.externalId);

      if (!internalId) {
        toCreate.push(pu);
      } else {
        const member = memberByUserId.get(internalId);
        if (member) {
          // Check if name changed or active status changed
          const currentActive = member.deactivatedAt === null;
          // A name this tenant cannot see is not this tenant's to sync: the
          // user's row is filed under another tenant, and RLS refuses the write
          // (measured: P2025, which rolled back the whole run).
          const nameChanged =
            visibleNameByUserId.has(internalId) &&
            visibleNameByUserId.get(internalId) !== pu.displayName;
          if (nameChanged || currentActive !== pu.active) {
            toUpdate.push({ user: pu, internalId });
          }
        }
      }
    }

    // Users to deactivate: have a mapping but were not in the provider response
    const toDeactivate: string[] = [];
    for (const [extId, internalId] of extIdToInternal) {
      if (!seenExternalIds.has(extId)) {
        const member = memberByUserId.get(internalId);
        if (member && member.deactivatedAt === null && member.role !== TENANT_ROLE.OWNER) {
          toDeactivate.push(internalId);
        }
      }
    }

    // 6. Safety guard
    const activeCount = existingMembers.filter(
      (m) => m.deactivatedAt === null,
    ).length;
    if (
      !force &&
      activeCount > 0 &&
      toDeactivate.length / activeCount > SAFETY_THRESHOLD
    ) {
      const msg = `Safety guard: ${toDeactivate.length} deactivations would exceed 20% of ${activeCount} active users. Use force=true to override.`;

      // Create log entry for the aborted sync
      const log = await withTenantRls(prisma, tenantId, (tx) =>
        tx.directorySyncLog.create({
          data: {
            configId,
            tenantId,
            status: "ERROR",
            startedAt,
            completedAt: new Date(),
            dryRun,
            usersCreated: 0,
            usersUpdated: 0,
            usersDeactivated: 0,
            usersRefused: 0,
            groupsUpdated: 0,
            errorMessage: sanitizeSyncError(msg),
          },
        }),
      );

      // Reset config status
      await withTenantRls(prisma, tenantId, (tx) =>
        tx.directorySyncConfig.update({
          where: { id: configId, tenantId },
          data: {
            status: "ERROR",
            lastSyncError: sanitizeSyncError(msg),
          },
        }),
      );

      return {
        success: false,
        dryRun,
        usersCreated: 0,
        usersUpdated: 0,
        usersDeactivated: 0,
        usersRefused: 0,
        groupsUpdated: 0,
        errorMessage: msg,
        abortedSafety: true,
        logId: log.id,
      };
    }

    // The cross-tenant guard the CREATE path in `api/scim/v2/Users` has and the
    // reactivation arms below did not. Resolved here, before the tenant context
    // opens: the foreign membership row is exactly what RLS hides inside one,
    // and opening a bypass inside one is refused by the nesting guard.
    //
    // Two active memberships is not a tolerable state — `resolveUserTenantId`
    // throws on it and the proxy auth gate calls that on every request, so
    // reactivating here would let this tenant's sync invalidate every session of
    // a user who belongs to another tenant.
    //
    // Resolved on a DRY RUN too. Skipping it there cost nothing at the time —
    // the preview writes nothing either way — but it made the preview predict a
    // run that would not happen: the operator saw every user reactivated, and
    // the real run then refused some of them.
    const activeElsewhere = await usersActiveInAnotherTenant(
      tenantId,
      toUpdate.map((u) => u.internalId),
      toCreate.map((pu) => pu.email.toLowerCase()),
    );

    // How each toCreate user's email stands toward this tenant, resolved before any
    // context opens and on a dry run too, so the preview declines what the run
    // declines: see `resolveExistingUsersForTenant`. A directory sync does not
    // authenticate the user, so it may attach an existing one only if this tenant
    // owns them, or already holds a membership row for them (round-5 S1).
    const existingUsers = await resolveExistingUsersForTenant(
      tenantId,
      toCreate.map((pu) => pu.email.toLowerCase()),
    );
    const declinedAttachment = (pu: ProviderUser): RefusalReason | null => {
      const resolution = existingUsers.get(pu.email.toLowerCase());
      if (resolution?.kind === "ambiguous") return REFUSAL_REASON.AMBIGUOUS_EMAIL;
      if (resolution?.kind === "foreign" && !resolution.memberHere) {
        return REFUSAL_REASON.OWNED_BY_ANOTHER_TENANT;
      }
      return null;
    };

    // 7. Apply changes (if not dryRun)
    if (!dryRun) {
      // Members this run activated whose users row already existed. Their owning
      // column may name another tenant, so each is realigned after the commit.
      const activated: string[] = [];
      await withTenantRls(prisma, tenantId, async (tx) => {
        const userByEmail = new Map<string, { id: string }>();
        for (const [email, resolution] of existingUsers) {
          if (resolution.kind !== "ambiguous") userByEmail.set(email, { id: resolution.userId });
        }

        // Create users no email matched at all. A user the lookup found is never
        // created again: inside this context one owned elsewhere is invisible, and
        // creating them collided on `users_email_key` and rolled back the run.
        for (const pu of toCreate) {
          const emailKey = pu.email.toLowerCase();
          if (!existingUsers.has(emailKey) && !userByEmail.has(emailKey)) {
            const newUser = await tx.user.create({
              data: { tenantId, email: pu.email, name: pu.displayName },
            });
            userByEmail.set(emailKey, newUser);
          }
        }

        // Batch pre-fetch: tenantMembers for every resolvable toCreate user
        const allUserIds = toCreate
          .map((pu) => userByEmail.get(pu.email.toLowerCase())?.id)
          .filter((id): id is string => id !== undefined);
        const existingTenantMembers = await tx.tenantMember.findMany({
          where: { tenantId, userId: { in: allUserIds } },
          select: { id: true, userId: true, deactivatedAt: true },
        });
        const tmByUserId = new Map(existingTenantMembers.map((m) => [m.userId, m]));

        // Process each user: create/reactivate tenantMember + upsert mapping
        for (const pu of toCreate) {
          const resolution = existingUsers.get(pu.email.toLowerCase());
          const user = userByEmail.get(pu.email.toLowerCase());
          const existing = user ? tmByUserId.get(user.id) : undefined;

          // Declined attachments write nothing — no membership and no mapping, so
          // nothing is left for a later run to reactivate. Decided on the in-context
          // membership read, so a row deleted since the lookup is not mistaken for
          // the one that made a foreign user attachable.
          if (!user || (resolution?.kind === "foreign" && !existing)) {
            usersRefused++;
            refusals.push({
              memberId: null,
              userId: resolution?.kind === "foreign" ? resolution.userId : null,
              email: pu.email,
              reason:
                resolution?.kind === "ambiguous"
                  ? REFUSAL_REASON.AMBIGUOUS_EMAIL
                  : REFUSAL_REASON.OWNED_BY_ANOTHER_TENANT,
            });
            continue;
          }

          if (!existing) {
            // The same `activeElsewhere` answer the reactivation arm below uses.
            // It was computed over exactly these emails and then not consulted
            // here: creating an ACTIVE membership for a user already active
            // elsewhere is the same second-active-membership the reactivation
            // arm refuses, reached by a different verb. The row is still created,
            // deactivated, so the mapping lands and a later legitimate
            // reactivation has a row to flip.
            const activeInAnother = activeElsewhere.emails.has(pu.email.toLowerCase());
            const created = await tx.tenantMember.create({
              data: {
                tenantId,
                userId: user.id,
                role: TENANT_ROLE.MEMBER,
                deactivatedAt: pu.active && !activeInAnother ? null : new Date(),
                scimManaged: true,
                provisioningSource: "SCIM",
                lastScimSyncedAt: new Date(),
              },
            });
            // Only when the IdP asked for an ACTIVE member and the guard said no.
            // A member the IdP itself sent as inactive is not a refusal.
            if (pu.active && activeInAnother) {
              usersRefused++;
              refusals.push({
                memberId: created.id,
                userId: user.id,
                email: pu.email,
                reason: REFUSAL_REASON.ACTIVE_IN_ANOTHER_TENANT,
              });
            } else if (pu.active && resolution) {
              activated.push(user.id);
            }
          } else if (existing.deactivatedAt && pu.active) {
            if (activeElsewhere.emails.has(pu.email.toLowerCase())) {
              // Refused, not silently skipped: the sync still stamps the sync
              // time so the run is not mistaken for one that never saw this user.
              await tx.tenantMember.update({
                where: { id: existing.id },
                data: { lastScimSyncedAt: new Date() },
              });
              usersRefused++;
              refusals.push({
                memberId: existing.id,
                userId: user.id,
                email: pu.email,
                reason: REFUSAL_REASON.ACTIVE_IN_ANOTHER_TENANT,
              });
            } else {
              // Reactivate
              await tx.tenantMember.update({
                where: { id: existing.id },
                data: { deactivatedAt: null, lastScimSyncedAt: new Date() },
              });
              activated.push(user.id);
            }
          }

          // Create or update external mapping
          await tx.scimExternalMapping.upsert({
            where: {
              tenantId_externalId_resourceType: {
                tenantId,
                externalId: pu.externalId,
                resourceType: "User",
              },
            },
            create: {
              tenantId,
              externalId: pu.externalId,
              resourceType: "User",
              internalId: user.id,
            },
            update: {
              internalId: user.id,
            },
          });

          usersCreated++;
        }

        // Update existing users
        for (const { user: pu, internalId } of toUpdate) {
          const member = memberByUserId.get(internalId);
          if (!member) continue;

          if (visibleNameByUserId.has(internalId)) {
            await tx.user.update({
              where: { id: internalId },
              data: { name: pu.displayName },
            });
          }

          // OWNER protection: skip deactivation for OWNER role
          if (member.role === TENANT_ROLE.OWNER && !pu.active) {
            usersUpdated++;
            continue;
          }

          // A reactivation is refused when it would make a second active
          // membership; a DEACTIVATION is always applied, because it cannot add
          // one and it is the operation that repairs the condition.
          const wouldReactivate = pu.active && member.deactivatedAt !== null;
          const refused = wouldReactivate && activeElsewhere.ids.has(internalId);
          await tx.tenantMember.update({
            where: { id: member.id },
            data: {
              deactivatedAt: refused
                ? member.deactivatedAt
                : pu.active
                  ? null
                  : new Date(),
              lastScimSyncedAt: new Date(),
            },
          });

          usersUpdated++;
          if (refused) {
            usersRefused++;
            refusals.push({
              memberId: member.id,
              userId: internalId,
              email: pu.email,
              reason: REFUSAL_REASON.ACTIVE_IN_ANOTHER_TENANT,
            });
          } else if (wouldReactivate) {
            activated.push(internalId);
          }
        }

        // Deactivate users no longer in provider (batch, OWNER-safe)
        if (toDeactivate.length > 0) {
          const memberIds = toDeactivate
            .map((userId) => memberByUserId.get(userId)?.id)
            .filter((id): id is string => id != null);

          if (memberIds.length > 0) {
            const result = await tx.tenantMember.updateMany({
              where: {
                id: { in: memberIds },
                tenantId,
                role: { not: TENANT_ROLE.OWNER },
              },
              data: {
                deactivatedAt: new Date(),
                lastScimSyncedAt: new Date(),
              },
            });
            usersDeactivated = result.count;
          }
        }
      });
      // After the commit, so a rolled-back run cannot leave a refusal in the
      // trail. Best-effort, like every other emit on this path — the durable
      // record of the count is the sync log row written below.
      await logAuditBulkAsync(
        refusals.map((r) => ({
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.DIRECTORY_SYNC_ACTIVATION_REFUSED,
          userId: resolveAuditUserId(actorUserId, "system"),
          actorType: actorUserId ? ACTOR_TYPE.HUMAN : ACTOR_TYPE.SYSTEM,
          tenantId,
          // A declined attachment has no membership to name; the sync config that
          // declined it is the target instead.
          targetType: r.memberId ? AUDIT_TARGET_TYPE.TENANT_MEMBER : AUDIT_TARGET_TYPE.DIRECTORY_SYNC_CONFIG,
          targetId: r.memberId ?? configId,
          metadata: { configId, userId: r.userId, email: r.email, reason: r.reason },
        })),
      );
      // After the commit too — and because the apply ran in this tenant's context,
      // which cannot write a users row filed under another tenant. Not atomic
      // with the activation: a failure leaves that member's column diverged, and
      // is logged rather than reported as a failed run whose writes committed.
      for (const activatedUserId of activated) {
        try {
          await realignAfterActivation(activatedUserId, tenantId);
        } catch (error) {
          getLogger().error(
            { tenantId, userId: activatedUserId, error: errorLogFields(error) },
            "directory-sync.realign-failed",
          );
        }
      }
    } else {
      // Dry run: count what would happen. A declined attachment writes nothing, so
      // it is a refusal and not a creation — the same split the apply phase makes.
      const declined = toCreate.filter((pu) => declinedAttachment(pu) !== null);
      usersCreated = toCreate.length - declined.length;
      usersUpdated = toUpdate.length;
      usersDeactivated = toDeactivate.length;
      // Both apply-phase arms refuse on the same condition — the IdP asked for an
      // ACTIVE member and the guard found one elsewhere — so the preview can
      // answer it without replaying the loops. The one case it cannot see is a
      // toCreate user who already holds an ACTIVE membership HERE: the apply
      // phase resolves that from the tx and refuses nothing, because there is
      // nothing to activate. That state is a second active membership already,
      // which `tenant_members_one_active_per_user` now makes unrepresentable.
      usersRefused =
        declined.length +
        toCreate.filter(
          (pu) =>
            declinedAttachment(pu) === null &&
            pu.active &&
            activeElsewhere.emails.has(pu.email.toLowerCase()),
        ).length +
        toUpdate.filter(({ user: pu, internalId }) => {
          const member = memberByUserId.get(internalId);
          return (
            !!member &&
            pu.active &&
            member.deactivatedAt !== null &&
            activeElsewhere.ids.has(internalId)
          );
        }).length;
    }

    // 8. Create sync log
    const completedAt = new Date();
    const stats = { usersCreated, usersUpdated, usersDeactivated, usersRefused, groupsUpdated };

    const log = await withTenantRls(prisma, tenantId, (tx) =>
      tx.directorySyncLog.create({
        data: {
          configId,
          tenantId,
          status: "SUCCESS",
          startedAt,
          completedAt,
          dryRun,
          usersCreated,
          usersUpdated,
          usersDeactivated,
          usersRefused,
          groupsUpdated,
        },
      }),
    );

    // 9. Update config status
    const nextSyncAt = new Date(
      completedAt.getTime() + (config.syncIntervalMinutes ?? 60) * MS_PER_MINUTE,
    );

    await withTenantRls(prisma, tenantId, (tx) =>
      tx.directorySyncConfig.update({
        where: { id: configId },
        data: {
          status: "SUCCESS",
          lastSyncAt: completedAt,
          lastSyncError: null,
          lastSyncStats: stats as unknown as Prisma.InputJsonValue,
          nextSyncAt,
        },
      }),
    );

    return {
      success: true,
      dryRun,
      usersCreated,
      usersUpdated,
      usersDeactivated,
      usersRefused,
      groupsUpdated,
      logId: log.id,
    };
  } catch (err) {
    // Write error to config
    await writeSyncError(configId, tenantId, err);

    // Create error log
    let logId: string | undefined;
    try {
      const log = await withTenantRls(prisma, tenantId, (tx) =>
        tx.directorySyncLog.create({
          data: {
            configId,
            tenantId,
            status: "ERROR",
            startedAt,
            completedAt: new Date(),
            dryRun,
            usersCreated,
            usersUpdated,
            usersDeactivated,
            usersRefused,
            groupsUpdated,
            errorMessage: sanitizeSyncError(err),
          },
        }),
      );
      logId = log.id;
    } catch {
      // best-effort
    }

    return {
      success: false,
      dryRun,
      usersCreated,
      usersUpdated,
      usersDeactivated,
      usersRefused,
      groupsUpdated,
      errorMessage: sanitizeSyncError(err),
      logId,
    };
  }
}
