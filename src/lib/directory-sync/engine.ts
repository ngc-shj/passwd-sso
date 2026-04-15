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
import { logAuditAsync } from "@/lib/audit";
import { dispatchTenantWebhook } from "@/lib/webhook-dispatcher";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, TENANT_ROLE } from "@/lib/constants";
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
  groupsUpdated: number;
  errorMessage?: string;
  abortedSafety?: boolean;
  logId?: string;
}

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
    await withTenantRls(prisma, tenantId, () =>
      prisma.directorySyncConfig.update({
        where: { id: configId },
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
      Date.now() - STALE_LOCK_MINUTES * 60 * 1000,
    );

    // Check for stale RUNNING state before CAS to detect stale-reset
    const preCheck = await withTenantRls(prisma, tenantId, () =>
      prisma.directorySyncConfig.findFirst({
        where: { id: configId, tenantId },
        select: { status: true, lastSyncAt: true },
      }),
    );
    const wasStaleRunning =
      preCheck?.status === "RUNNING" &&
      preCheck.lastSyncAt &&
      preCheck.lastSyncAt < staleThreshold;

    const updated = await withTenantRls(prisma, tenantId, () =>
      prisma.$executeRaw`
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
        userId: actorUserId ?? null,
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
      groupsUpdated: 0,
      errorMessage: "Sync already running (locked)",
    };
  }

  let usersCreated = 0;
  let usersUpdated = 0;
  let usersDeactivated = 0;
  const groupsUpdated = 0;

  try {
    // 2. Load config and decrypt credentials
    const config = await withTenantRls(prisma, tenantId, () =>
      prisma.directorySyncConfig.findUnique({
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
    const [existingMappings, existingMembers] = await withTenantRls(
      prisma,
      tenantId,
      () =>
        Promise.all([
          prisma.scimExternalMapping.findMany({
            where: { tenantId, resourceType: "User" },
            select: { externalId: true, internalId: true },
          }),
          prisma.tenantMember.findMany({
            where: { tenantId },
            select: {
              id: true,
              userId: true,
              deactivatedAt: true,
              role: true,
              user: { select: { id: true, email: true, name: true } },
            },
          }),
        ]),
    );

    const extIdToInternal = new Map(
      existingMappings.map((m) => [m.externalId, m.internalId]),
    );
    const memberByUserId = new Map(
      existingMembers.map((m) => [m.userId, m]),
    );

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
          if (
            member.user.name !== pu.displayName ||
            currentActive !== pu.active
          ) {
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
      const log = await withTenantRls(prisma, tenantId, () =>
        prisma.directorySyncLog.create({
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
            groupsUpdated: 0,
            errorMessage: sanitizeSyncError(msg),
          },
        }),
      );

      // Reset config status
      await withTenantRls(prisma, tenantId, () =>
        prisma.directorySyncConfig.update({
          where: { id: configId },
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
        groupsUpdated: 0,
        errorMessage: msg,
        abortedSafety: true,
        logId: log.id,
      };
    }

    // 7. Apply changes (if not dryRun)
    if (!dryRun) {
      await withTenantRls(prisma, tenantId, () =>
        prisma.$transaction(async (tx) => {
          // Create new users
          // Batch pre-fetch: all users by email for toCreate
          const createEmails = toCreate.map((pu) => pu.email.toLowerCase());
          const existingUsers = await tx.user.findMany({
            where: { email: { in: createEmails, mode: "insensitive" } },
            select: { id: true, email: true },
          });
          const userByEmail = new Map(existingUsers.map((u) => [u.email!.toLowerCase(), u]));

          // Create missing users individually (need IDs back)
          for (const pu of toCreate) {
            const emailKey = pu.email.toLowerCase();
            if (!userByEmail.has(emailKey)) {
              const newUser = await tx.user.create({
                data: { tenantId, email: pu.email, name: pu.displayName },
              });
              userByEmail.set(emailKey, newUser);
            }
          }

          // Batch pre-fetch: tenantMembers for all users in toCreate
          const allUserIds = toCreate.map((pu) => userByEmail.get(pu.email.toLowerCase())!.id);
          const existingTenantMembers = await tx.tenantMember.findMany({
            where: { tenantId, userId: { in: allUserIds } },
            select: { id: true, userId: true, deactivatedAt: true },
          });
          const tmByUserId = new Map(existingTenantMembers.map((m) => [m.userId, m]));

          // Process each user: create/reactivate tenantMember + upsert mapping
          for (const pu of toCreate) {
            const user = userByEmail.get(pu.email.toLowerCase())!;
            const existing = tmByUserId.get(user.id);

            if (!existing) {
              await tx.tenantMember.create({
                data: {
                  tenantId,
                  userId: user.id,
                  role: "MEMBER",
                  deactivatedAt: pu.active ? null : new Date(),
                  scimManaged: true,
                  provisioningSource: "SCIM",
                  lastScimSyncedAt: new Date(),
                },
              });
            } else if (existing.deactivatedAt && pu.active) {
              // Reactivate
              await tx.tenantMember.update({
                where: { id: existing.id },
                data: { deactivatedAt: null, lastScimSyncedAt: new Date() },
              });
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

            await tx.user.update({
              where: { id: internalId },
              data: { name: pu.displayName },
            });

            // OWNER protection: skip deactivation for OWNER role
            if (member.role === TENANT_ROLE.OWNER && !pu.active) {
              usersUpdated++;
              continue;
            }

            await tx.tenantMember.update({
              where: { id: member.id },
              data: {
                deactivatedAt: pu.active ? null : new Date(),
                lastScimSyncedAt: new Date(),
              },
            });

            usersUpdated++;
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
        }),
      );
    } else {
      // Dry run: count what would happen
      usersCreated = toCreate.length;
      usersUpdated = toUpdate.length;
      usersDeactivated = toDeactivate.length;
    }

    // 8. Create sync log
    const completedAt = new Date();
    const stats = { usersCreated, usersUpdated, usersDeactivated, groupsUpdated };

    const log = await withTenantRls(prisma, tenantId, () =>
      prisma.directorySyncLog.create({
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
          groupsUpdated,
        },
      }),
    );

    // 9. Update config status
    const nextSyncAt = new Date(
      completedAt.getTime() + (config.syncIntervalMinutes ?? 60) * 60 * 1000,
    );

    await withTenantRls(prisma, tenantId, () =>
      prisma.directorySyncConfig.update({
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
      groupsUpdated,
      logId: log.id,
    };
  } catch (err) {
    // Write error to config
    await writeSyncError(configId, tenantId, err);

    // Create error log
    let logId: string | undefined;
    try {
      const log = await withTenantRls(prisma, tenantId, () =>
        prisma.directorySyncLog.create({
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
      groupsUpdated,
      errorMessage: sanitizeSyncError(err),
      logId,
    };
  }
}
