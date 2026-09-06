/**
 * Vault auto-promote helper — extracted from [id]/vault/route.ts for
 * lib-level testability (T17 — no HTTP harness required).
 *
 * Audit is emitted from this function on every path the CAS succeeded on, via
 * `logAuditInTx` on the caller's transaction. The concurrent "loser" does not
 * emit (CAS in transition() ensures exactly one caller wins the REQUESTED →
 * ACTIVATED flip).
 *
 * This used to say the emit was "gated on the post-refetch success path", and
 * that was the defect: the `revoked` and `no_escrow` exits return normally, the
 * route answers 403, and the enclosing transaction commits — so the grant went
 * to ACTIVATED with no audit row. `metadata.outcome` is what now distinguishes
 * the three, because a released escrow and a withheld one are the same action
 * value and this path emits no EMERGENCY_VAULT_ACCESS.
 *
 * Bypass-RLS contract: this lib does NOT call withBypassRls itself. Callers
 * MUST invoke under an active withBypassRls scope (the route does, the
 * integration test does too). The prisma proxy in src/lib/prisma.ts:145-174
 * inherits the active context via AsyncLocalStorage. Keeping the bypass
 * decision at the call site (route handler) preserves the existing security
 * review boundary — see scripts/checks/check-bypass-rls.mjs ALLOWED_USAGE.
 */

import type { Prisma } from "@prisma/client";
import type { TxOrPrisma } from "@/lib/prisma";
import { transition } from "./emergency-access-state";
import { logAuditInTx, type AuditLogParams } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, EA_STATUS, EA_ACTOR } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";

/**
 * What the activation did about the owner's escrowed key material.
 *
 * `EMERGENCY_ACCESS_ACTIVATE` is written on every path a CAS committed
 * `ACTIVATED`, and those paths do not mean the same thing. This path emits no
 * `EMERGENCY_VAULT_ACCESS` — the only emitter of that action is
 * `/vault/entries` — so without a discriminator an auditor cannot tell a
 * released escrow from a withheld one.
 *
 * `APPROVED` is the owner's early-approval row. That route changes state and
 * nothing else: it does not read `encryptedSecretKey` or `granteeKeyPair`, and
 * the release, if it happens, is a LATER request. Labelling it `RELEASED` would
 * assert something the emitting route never checked, on a grant that may have
 * no escrow at all.
 */
export const EA_ACTIVATE_OUTCOME = {
  /** The grantee received the escrowed key material in this response. */
  RELEASED: "released",
  /** Promoted, then withheld: the grant was revoked concurrently. */
  REVOKED: "revoked",
  /** Promoted, then withheld: no escrow to hand over. */
  NO_ESCROW: "no_escrow",
  /** Owner-approved. State changed; no release attempted on this request. */
  APPROVED: "approved",
} as const;

export type EaActivateOutcome =
  (typeof EA_ACTIVATE_OUTCOME)[keyof typeof EA_ACTIVATE_OUTCOME];

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
 *  4. Re-fetches the grant under withBypassRls.
 *  5. Classifies the outcome; revokedAt is checked before encryptedSecretKey
 *     (F5/S15 ordering) — "revoked" | "no_escrow" | "released".
 *  6. Emits EMERGENCY_ACCESS_ACTIVATE via logAuditInTx on EVERY outcome, because
 *     all three follow a CAS that committed ACTIVATED. `metadata.outcome` is
 *     what distinguishes a released escrow from a withheld one.
 *  7. Returns { ok: false; reason } for the first two, { ok: true; grant } for
 *     the third.
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

  // Step 1: fetch current grant state to check eligibility.
  // `ownerId` is selected here, not read off the post-CAS re-fetch, because the
  // audit row must cover every path on which the CAS succeeded — including the
  // one where the re-fetch returns null and there is no object to read it from.
  const current = await db.emergencyAccessGrant.findUnique({
    where: { id: grantId },
    select: { status: true, waitExpiresAt: true, granteeId: true, ownerId: true },
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

  // Step 5: classify the outcome. revokedAt precedes encryptedSecretKey (F5/S15
  // ordering). The classification happens BEFORE the returns so a single emit
  // can carry it — see the emit below for why that ordering is load-bearing.
  const outcome: EaActivateOutcome =
    !updated || updated.revokedAt !== null
      ? EA_ACTIVATE_OUTCOME.REVOKED
      : !updated.encryptedSecretKey || !updated.granteeKeyPair
        ? EA_ACTIVATE_OUTCOME.NO_ESCROW
        : EA_ACTIVATE_OUTCOME.RELEASED;

  // Step 6: emit on EVERY path the CAS succeeded on, atomically with it.
  //
  // Two things changed here and they depend on each other. The emit used to be
  // `logAuditAsync` placed after the two guard returns, so the `revoked` and
  // `no_escrow` exits — which do not throw, and whose 403 still lets the
  // enclosing transaction COMMIT — left the grant `ACTIVATED` with no audit row
  // at all. And `logAuditAsync` reached `enqueueAudit`, whose raw
  // `prisma.$transaction` the Proxy folds into this transaction, forging its
  // `app.bypass_purpose` on the way past. `logAuditInTx` writes on the caller's
  // `tx`, so the row and the state change now commit together or not at all.
  //
  // The emit sits after the classification rather than immediately after the CAS
  // because `outcome` is what distinguishes "the grantee received the owner's
  // escrowed key material" from "the state changed and nothing was released" —
  // and this path emits no EMERGENCY_VAULT_ACCESS, so this row is the only
  // record of either. `ownerId` comes from the pre-CAS read, which is what keeps
  // the `!updated` arm safe.
  // The grantee's tenant, resolved through `User.tenantId` — the same column
  // `resolveTenantId` reads, so the row lands where it landed before. Not
  // `resolveUserTenantId`, which reads `TenantMember` and throws on a
  // multi-membership user: that would turn a working escrow release into a
  // rolled-back 500 for a condition this operation does not care about.
  const grantee = await db.user.findUnique({
    where: { id: granteeId },
    select: { tenantId: true },
  });
  if (!grantee) {
    // Unreachable inside the transaction that just locked the grant, whose
    // granteeId is an FK to this row. Fail rather than file the release under a
    // tenant nobody owns — a silently unattributable escrow-release record is
    // the outcome this whole contract exists to prevent.
    throw new Error(`autoPromoteIfElapsed: grantee ${granteeId} not found`);
  }

  await logAuditInTx(db as Prisma.TransactionClient, grantee.tenantId, {
    ...auditBase,
    actorType: ACTOR_TYPE.SYSTEM,
    action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grantId,
    metadata: { ownerId: current.ownerId, outcome },
  });

  if (outcome === EA_ACTIVATE_OUTCOME.REVOKED) {
    return { ok: false, reason: "revoked" };
  }

  if (outcome === EA_ACTIVATE_OUTCOME.NO_ESCROW) {
    return { ok: false, reason: "no_escrow" };
  }

  // Narrowing for the success path: `outcome === RELEASED` already implies both,
  // but the compiler cannot see it through the ternary chain above.
  if (!updated || !updated.encryptedSecretKey || !updated.granteeKeyPair) {
    return { ok: false, reason: "no_escrow" };
  }

  // Step 7: return crypto fields
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
