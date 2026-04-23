/**
 * Delegated Decryption — core library.
 *
 * Manages delegation sessions that allow MCP agents to read
 * pre-approved vault entry metadata. Metadata (title, username, urlHost, tags)
 * is stored in Redis with envelope encryption (AES-256-GCM) and short TTLs.
 * Secret fields (password, notes, url) are never stored on the server.
 */

import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  encryptServerData,
  decryptServerData,
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import type { ServerEncryptedData } from "@/lib/crypto/crypto-server";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";

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

// DelegationMetadata contains only non-secret fields safe to store on the server.
// Old Redis entries that still contain password/notes fields are silently ignored —
// those fields are simply dropped when parsed into this type. TTL expiry handles cleanup.
export interface DelegationMetadata {
  id: string;
  title: string;
  username?: string | null;
  urlHost?: string | null;
  tags?: string[] | null;
}

export async function storeDelegationEntries(
  userId: string,
  sessionId: string,
  entries: DelegationMetadata[],
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
): Promise<DelegationMetadata | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = delegationEntryKey(userId, sessionId, entryId);
  const raw = await redis.get(key);
  if (!raw) return null;

  const payload: DelegationEncryptedPayload = JSON.parse(raw);
  const plaintext = decryptDelegationEntry(payload, key);
  // Cast to DelegationMetadata — extra fields (password/notes from old entries) are ignored
  const parsed = JSON.parse(plaintext) as Record<string, unknown>;
  return {
    id: parsed.id as string,
    title: parsed.title as string,
    username: parsed.username as string | null | undefined,
    urlHost: parsed.urlHost as string | null | undefined,
    tags: parsed.tags as string[] | null | undefined,
  };
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

// ─── Query Helpers ─────────────────────────────────────────────

export async function getDelegatedEntryIds(
  userId: string,
  mcpTokenId: string,
): Promise<Set<string>> {
  const session = await findActiveDelegationSession(userId, mcpTokenId);
  if (!session) return new Set();
  return getDelegatedEntryIdsForSession(userId, session.id);
}

export async function getDelegatedEntryIdsForSession(
  userId: string,
  sessionId: string,
): Promise<Set<string>> {
  const redis = getRedis();
  if (!redis) return new Set();

  const indexKey = delegationIndexKey(userId, sessionId);
  const ids = await redis.smembers(indexKey);
  return new Set(ids);
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
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
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
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (sessions.length === 0) return 0;

  // Evict Redis keys for each session
  for (const session of sessions) {
    await evictDelegationRedisKeys(userId, session.id).catch(() => {});
  }

  // Bulk update DB — constrained to findMany IDs to avoid TOCTOU
  const sessionIds = sessions.map((s) => s.id);
  const result = await withBypassRls(prisma, () =>
    prisma.delegationSession.updateMany({
      where: {
        id: { in: sessionIds },
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (result.count > 0 && tenantId) {
    const auditBase = {
      action: AUDIT_ACTION.DELEGATION_REVOKE,
      userId,
      tenantId,
      metadata: { revokedCount: result.count, reason: reason ?? "manual" },
    };
    await Promise.all([
      logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL }),
      logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.TENANT }),
    ]);
  }

  return result.count;
}

export async function revokeDelegationSession(
  userId: string,
  sessionId: string,
  tenantId: string,
): Promise<boolean> {
  // DB first, then Redis — failed DB leaves Redis intact (safer failure mode)
  const result = await withBypassRls(prisma, () =>
    prisma.delegationSession.updateMany({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // Evict Redis keys (best-effort; TTL handles cleanup if this fails)
  await evictDelegationRedisKeys(userId, sessionId).catch(() => {});

  if (result.count > 0) {
    const auditBase = {
      action: AUDIT_ACTION.DELEGATION_REVOKE,
      userId,
      tenantId,
      targetId: sessionId,
      metadata: { reason: "manual" },
    };
    await Promise.all([
      logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.PERSONAL }),
      logAuditAsync({ ...auditBase, scope: AUDIT_SCOPE.TENANT }),
    ]);
  }

  return result.count > 0;
}
