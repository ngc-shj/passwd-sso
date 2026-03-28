/**
 * Delegated Decryption — core library.
 *
 * Manages delegation sessions that allow MCP agents to read
 * pre-approved decrypted vault entries. Plaintext is stored in Redis
 * with envelope encryption (AES-256-GCM) and short TTLs.
 */

import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { withBypassRls } from "@/lib/tenant-rls";
import {
  encryptServerData,
  decryptServerData,
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto-server";
import type { ServerEncryptedData } from "@/lib/crypto-server";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";

// ─── Constants ─────────────────────────────────────────────────

export const DELEGATION_DEFAULT_TTL_SEC = 900; // 15 minutes
export const DELEGATION_MAX_TTL_SEC = 3600; // 1 hour
export const DELEGATION_MAX_ENTRIES = 20;
export const DELEGATION_MIN_TTL_SEC = 300; // 5 minutes

// ─── Redis Key Builders ────────────────────────────────────────

export function delegationEntryKey(
  userId: string,
  sessionId: string,
  entryId: string,
): string {
  return `delegation:${userId}:${sessionId}:entry:${entryId}`;
}

export function delegationIndexKey(
  userId: string,
  sessionId: string,
): string {
  return `delegation:${userId}:${sessionId}:entries_index`;
}

// ─── Envelope Encryption (with AAD + masterKeyVersion) ─────────

interface DelegationEncryptedPayload {
  encrypted: ServerEncryptedData;
  masterKeyVersion: number;
}

export function encryptDelegationEntry(
  plaintext: string,
  aadKey: string,
): DelegationEncryptedPayload {
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const aad = Buffer.from(aadKey);
  const encrypted = encryptServerData(plaintext, masterKey, aad);
  return { encrypted, masterKeyVersion: version };
}

export function decryptDelegationEntry(
  payload: DelegationEncryptedPayload,
  aadKey: string,
): string {
  const masterKey = getMasterKeyByVersion(payload.masterKeyVersion);
  const aad = Buffer.from(aadKey);
  return decryptServerData(payload.encrypted, masterKey, aad);
}

// ─── Redis Operations ──────────────────────────────────────────

export interface DelegationEntryData {
  id: string;
  title: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
  notes?: string | null;
}

export async function storeDelegationEntries(
  userId: string,
  sessionId: string,
  entries: DelegationEntryData[],
  ttlMs: number,
): Promise<void> {
  const redis = getRedis();
  if (!redis) throw new Error("Redis unavailable: cannot store delegation entries");

  const pipeline = redis.pipeline();
  const entryIds: string[] = [];

  for (const entry of entries) {
    const key = delegationEntryKey(userId, sessionId, entry.id);
    const payload = encryptDelegationEntry(JSON.stringify(entry), key);
    pipeline.set(key, JSON.stringify(payload), "PX", ttlMs);
    entryIds.push(entry.id);
  }

  const indexKey = delegationIndexKey(userId, sessionId);
  if (entryIds.length > 0) {
    pipeline.sadd(indexKey, ...entryIds);
    pipeline.pexpire(indexKey, ttlMs);
  }

  const results = await pipeline.exec();
  if (results) {
    const failed = results.find(([err]) => err !== null);
    if (failed) throw new Error(`Redis pipeline command failed: ${failed[0]}`);
  }
}

export async function fetchDelegationEntry(
  userId: string,
  sessionId: string,
  entryId: string,
): Promise<DelegationEntryData | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = delegationEntryKey(userId, sessionId, entryId);
  const raw = await redis.get(key);
  if (!raw) return null;

  const payload: DelegationEncryptedPayload = JSON.parse(raw);
  const plaintext = decryptDelegationEntry(payload, key);
  return JSON.parse(plaintext) as DelegationEntryData;
}

export async function evictDelegationRedisKeys(
  userId: string,
  sessionId: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const indexKey = delegationIndexKey(userId, sessionId);
  const entryIds = await redis.smembers(indexKey);

  if (entryIds.length === 0) {
    await redis.del(indexKey);
    return;
  }

  const pipeline = redis.pipeline();
  for (const entryId of entryIds) {
    pipeline.del(delegationEntryKey(userId, sessionId, entryId));
  }
  pipeline.del(indexKey);
  await pipeline.exec();
}

// ─── DB Operations ─────────────────────────────────────────────

export async function findActiveDelegationSession(
  userId: string,
  mcpTokenId: string,
): Promise<{ id: string; expiresAt: Date } | null> {
  return withBypassRls(prisma, () =>
    prisma.delegationSession.findFirst({
      where: {
        userId,
        mcpTokenId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    }),
  );
}

export async function revokeAllDelegationSessions(
  userId: string,
  tenantId?: string,
  reason?: string,
): Promise<number> {
  const sessions = await withBypassRls(prisma, () =>
    prisma.delegationSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
  );

  if (sessions.length === 0) return 0;

  // Evict Redis keys for each session
  for (const session of sessions) {
    await evictDelegationRedisKeys(userId, session.id).catch(() => {});
  }

  // Bulk update DB
  const result = await withBypassRls(prisma, () =>
    prisma.delegationSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    }),
  );

  if (result.count > 0 && tenantId) {
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.DELEGATION_REVOKE,
      userId,
      tenantId,
      metadata: { revokedCount: result.count, reason: reason ?? "manual" },
    });
  }

  return result.count;
}

export async function revokeDelegationSession(
  userId: string,
  sessionId: string,
  tenantId: string,
): Promise<boolean> {
  // Evict Redis keys
  await evictDelegationRedisKeys(userId, sessionId).catch(() => {});

  const result = await withBypassRls(prisma, () =>
    prisma.delegationSession.updateMany({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
  );

  if (result.count > 0) {
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.DELEGATION_REVOKE,
      userId,
      tenantId,
      targetId: sessionId,
      metadata: { reason: "manual" },
    });
  }

  return result.count > 0;
}
