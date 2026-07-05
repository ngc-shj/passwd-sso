/**
 * Vault auto-promote helper — extracted from [id]/vault/route.ts for
 * lib-level testability (T17 — no HTTP harness required).
 *
 * C5: audit is emitted from this function, gated on the post-refetch success
 * path. The concurrent "loser" does not emit (CAS in transition() ensures
 * exactly one caller wins the REQUESTED → ACTIVATED flip).
 *
 * Bypass-RLS contract: this lib does NOT call withBypassRls itself. Callers
 * MUST invoke under an active withBypassRls scope (the route does, the
 * integration test does too). The prisma proxy in src/lib/prisma.ts:145-174
 * inherits the active context via AsyncLocalStorage. Keeping the bypass
 * decision at the call site (route handler) preserves the existing security
 * review boundary — see scripts/checks/check-bypass-rls.mjs ALLOWED_USAGE.
 */

import type { TxOrPrisma } from "@/lib/prisma";
import { transition } from "./emergency-access-state";
import { logAuditAsync, type AuditLogParams } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, EA_STATUS, EA_ACTOR } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";

/**
 * Crypto fields returned to the route on successful promotion.
 * Matches the shape serialized in the JSON response.
 */
export interface GrantCryptoFields {
  id: string;
  ownerId: string;
  granteeId: string | null;
  ownerEphemeralPublicKey: string | null;
  encryptedSecretKey: string | null;
  secretKeyIv: string | null;
  secretKeyAuthTag: string | null;
  hkdfSalt: string | null;
  wrapVersion: number | null;
  keyVersion: number | null;
  keyAlgorithm: string | null;
  revokedAt: Date | null;
  granteeKeyPair: {
    encryptedPrivateKey: string;
    privateKeyIv: string;
    privateKeyAuthTag: string;
  } | null;
  owner: { name: string | null; email: string | null } | null;
}

export type AutoPromoteResult =
  | { ok: true; grant: GrantCryptoFields }
  | { ok: false; reason: "not_eligible" | "revoked" | "no_escrow" };

/**
 * If the grant is REQUESTED and waitExpiresAt has elapsed, atomically promote
 * REQUESTED → ACTIVATED via transition() (CAS-protected — closes the race
 * window where two concurrent vault GETs both flip status).
 *
 * Per F5/S15 and the plan's spec:
 *  1. Checks current grant status and waitExpiresAt under withBypassRls.
 *  2. If not eligible: returns { ok: false; reason: "not_eligible" }.
 *  3. Calls transition({ to: ACTIVATED, actor: SYSTEM }).
 *     On { ok: false }: returns "not_eligible" (concurrent winner already promoted).
 *  4. Re-fetches the grant under withBypassRls; validates revokedAt: null FIRST.
 *     - revokedAt set → { ok: false; reason: "revoked" }
 *     - encryptedSecretKey null → { ok: false; reason: "no_escrow" }
 *  5. Emits EMERGENCY_ACCESS_ACTIVATE audit ONLY on the success path.
 *  6. Returns { ok: true; grant }.
 *
 * Behavior note: replaces the former non-CAS update() in the route. Concurrent
 * requests now resolve deterministically — exactly one wins, the loser returns
 * "not_eligible" and the route falls through to the NOT_ACTIVATED 403 check.
 */
export async function autoPromoteIfElapsed(args: {
  db: TxOrPrisma;
  granteeId: string;
  grantId: string;
  now: Date;
  // Subset of AuditLogParams that the route has available (no action/targetType/targetId/metadata).
  // Matches the shape returned by personalAuditBase(req, userId).
  auditBase: Omit<AuditLogParams, "action" | "targetType" | "targetId" | "metadata" | "actorType">;
}): Promise<AutoPromoteResult> {
  const { db, granteeId, grantId, now, auditBase } = args;

  // Caller MUST wrap in withBypassRls and pass its tx as `db` — see file header.

  // Step 1: fetch current grant state to check eligibility
  const current = await db.emergencyAccessGrant.findUnique({
    where: { id: grantId },
    select: { status: true, waitExpiresAt: true, granteeId: true },
  });

  // Step 2: eligibility check
  if (
    !current ||
    current.granteeId !== granteeId ||
    current.status !== EA_STATUS.REQUESTED ||
    !current.waitExpiresAt ||
    current.waitExpiresAt > now
  ) {
    return { ok: false, reason: "not_eligible" };
  }

  // Step 3: CAS-protected transition (closes race window)
  const promoted = await transition({
    db,
    where: { id: grantId, granteeId },
    to: EA_STATUS.ACTIVATED,
    actor: EA_ACTOR.SYSTEM,
    extraData: { activatedAt: now },
  });

  if (!promoted.ok) {
    // Concurrent winner already promoted; this caller is the loser.
    return { ok: false, reason: "not_eligible" };
  }

  // Step 4: re-fetch to get the authoritative post-promotion state
  const updated = await db.emergencyAccessGrant.findUnique({
    where: { id: grantId },
    include: {
      granteeKeyPair: true,
      owner: { select: { name: true, email: true } },
    },
  });

  // revokedAt check precedes encryptedSecretKey check (F5/S15 ordering)
  if (!updated || updated.revokedAt !== null) {
    return { ok: false, reason: "revoked" };
  }

  if (!updated.encryptedSecretKey || !updated.granteeKeyPair) {
    return { ok: false, reason: "no_escrow" };
  }

  // Step 5: emit audit ONLY on the success path (C5)
  await logAuditAsync({
    ...auditBase,
    actorType: ACTOR_TYPE.SYSTEM,
    action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grantId,
    metadata: { ownerId: updated.ownerId },
  });

  // Step 6: return crypto fields
  return {
    ok: true,
    grant: {
      id: updated.id,
      ownerId: updated.ownerId,
      granteeId: updated.granteeId,
      ownerEphemeralPublicKey: updated.ownerEphemeralPublicKey,
      encryptedSecretKey: updated.encryptedSecretKey,
      secretKeyIv: updated.secretKeyIv,
      secretKeyAuthTag: updated.secretKeyAuthTag,
      hkdfSalt: updated.hkdfSalt,
      wrapVersion: updated.wrapVersion,
      keyVersion: updated.keyVersion,
      keyAlgorithm: updated.keyAlgorithm,
      revokedAt: updated.revokedAt,
      granteeKeyPair: updated.granteeKeyPair,
      owner: updated.owner,
    },
  };
}
