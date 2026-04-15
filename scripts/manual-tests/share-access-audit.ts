/* eslint-disable no-console */
/**
 * Manual test: share-links/verify-access audit logging for anonymous access.
 *
 * Verifies that SHARE_ACCESS_VERIFY_FAILED / SHARE_ACCESS_VERIFY_SUCCESS
 * events for anonymous callers are written via the audit_outbox → worker →
 * audit_logs path (user_id=ANONYMOUS_ACTOR_ID, actor_type=ANONYMOUS).
 *
 * New flow (post audit-path-unification):
 *   1. API handler calls logAuditAsync with ANONYMOUS_ACTOR_ID + actorType ANONYMOUS
 *   2. enqueueAudit writes a row to audit_outbox (status=PENDING) within the same tx
 *   3. The outbox worker drains it to audit_logs and marks the outbox row SENT
 *   4. For tenants with a configured audit_delivery_target, an audit_deliveries row
 *      is also created for SIEM fan-out (brute-force detection via SHARE_ACCESS_VERIFY_FAILED)
 *
 * Expected invariants:
 *   - audit_logs.user_id = ANONYMOUS_ACTOR_ID (not NULL)
 *   - audit_logs.actor_type = 'ANONYMOUS' (not 'SYSTEM')
 *   - audit_logs.outbox_id IS NOT NULL (routed through outbox)
 *   - audit_outbox.status = 'SENT' (worker processed the row)
 *   - metadata.anonymousAccess key does NOT exist (removed per MF15)
 *
 * See scripts/manual-tests/README.md for usage.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { hashToken, hashAccessPassword, encryptShareData } from "@/lib/crypto-server";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { randomBytes } from "node:crypto";

async function main() {
  const entry = await withBypassRls(prisma, () =>
    prisma.passwordEntry.findFirst({
      select: { id: true, userId: true, tenantId: true },
      where: { deletedAt: null },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  if (!entry) {
    console.error("No password entry found. Create one via UI first.");
    process.exit(1);
  }

  const tokenPlain = randomBytes(32).toString("hex");
  const tokenHash = hashToken(tokenPlain);
  const accessPw = "test-password-12345";
  const accessPwHash = hashAccessPassword(accessPw);

  const enc = encryptShareData(JSON.stringify({ note: "audit-test" }));
  const share = await withBypassRls(prisma, () =>
    prisma.passwordShare.create({
      data: {
        tokenHash,
        accessPasswordHash: accessPwHash,
        tenantId: entry.tenantId,
        createdById: entry.userId,
        passwordEntryId: entry.id,
        encryptedData: enc.ciphertext,
        dataIv: enc.iv,
        dataAuthTag: enc.authTag,
        masterKeyVersion: enc.masterKeyVersion,
        expiresAt: new Date(Date.now() + 60_000),
        maxViews: 100,
        viewCount: 0,
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  console.log(`Created test share id=${share.id} (tenant=${entry.tenantId})`);

  const baseUrl = "https://localhost:3001/passwd-sso/api/share-links/verify-access";
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const r1 = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenPlain, password: "wrong-password" }),
  });
  console.log(`\n[TEST 1] wrong password → HTTP ${r1.status}`);
  console.log(`  body: ${(await r1.text()).slice(0, 200)}`);

  const r2 = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenPlain, password: accessPw }),
  });
  console.log(`\n[TEST 2] correct password → HTTP ${r2.status}`);
  console.log(`  body: ${(await r2.text()).slice(0, 200)}`);

  await new Promise((r) => setTimeout(r, 500));

  const logs = await withBypassRls(prisma, () =>
    prisma.$queryRaw<
      Array<{
        action: string;
        user_id: string;
        actor_type: string;
        anon_key_exists: boolean;
        ip: string | null;
        outbox_id: string | null;
        created_at: Date;
      }>
    >`
      SELECT action, user_id, actor_type,
             (metadata ? 'anonymousAccess') AS anon_key_exists,
             metadata->>'ip' AS ip,
             outbox_id,
             created_at
      FROM audit_logs
      WHERE tenant_id = ${entry.tenantId}::uuid
        AND action IN ('SHARE_ACCESS_VERIFY_FAILED', 'SHARE_ACCESS_VERIFY_SUCCESS')
        AND target_id = ${share.id}
      ORDER BY created_at DESC
      LIMIT 5
    `,
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  console.log(`\n[AUDIT LOGS]`);
  console.table(logs);

  const outbox = await withBypassRls(prisma, () =>
    prisma.$queryRaw<
      Array<{ id: string; status: string; action: string; user_id: string; actor_type: string; created_at: Date }>
    >`
      SELECT id, status, payload->>'action' AS action,
             payload->>'userId' AS user_id,
             payload->>'actorType' AS actor_type,
             created_at
      FROM audit_outbox
      WHERE tenant_id = ${entry.tenantId}::uuid
        AND payload->>'action' IN ('SHARE_ACCESS_VERIFY_FAILED', 'SHARE_ACCESS_VERIFY_SUCCESS')
        AND payload->>'targetId' = ${share.id}
      ORDER BY created_at DESC
      LIMIT 5
    `,
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  console.log(`\n[OUTBOX (should have SENT rows — routed through outbox)]`);
  console.table(outbox);

  await withBypassRls(prisma, () =>
    prisma.passwordShare.delete({ where: { id: share.id } }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  console.log(`\nCleaned up test share ${share.id}`);

  const failedRow = logs.find((r) => r.action === "SHARE_ACCESS_VERIFY_FAILED");
  const successRow = logs.find((r) => r.action === "SHARE_ACCESS_VERIFY_SUCCESS");
  const failedOutbox = outbox.find((r) => r.action === "SHARE_ACCESS_VERIFY_FAILED");
  const successOutbox = outbox.find((r) => r.action === "SHARE_ACCESS_VERIFY_SUCCESS");
  let ok = true;
  const check = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
    if (!cond) ok = false;
  };
  console.log(`\n[VERIFICATION]`);
  check(r1.status === 403, "wrong password returns 403");
  check(r2.status === 200, "correct password returns 200");
  check(failedRow != null, "SHARE_ACCESS_VERIFY_FAILED row exists in audit_logs");
  check(successRow != null, "SHARE_ACCESS_VERIFY_SUCCESS row exists in audit_logs");
  if (failedRow) {
    check(failedRow.user_id === ANONYMOUS_ACTOR_ID, "FAILED row: user_id = ANONYMOUS_ACTOR_ID");
    check(failedRow.actor_type === "ANONYMOUS", "FAILED row: actor_type = ANONYMOUS");
    check(failedRow.anon_key_exists === false, "FAILED row: metadata.anonymousAccess key absent (removed per MF15)");
    check(failedRow.outbox_id !== null, "FAILED row: outbox_id IS NOT NULL (routed through outbox)");
  }
  if (successRow) {
    check(successRow.user_id === ANONYMOUS_ACTOR_ID, "SUCCESS row: user_id = ANONYMOUS_ACTOR_ID");
    check(successRow.actor_type === "ANONYMOUS", "SUCCESS row: actor_type = ANONYMOUS");
    check(successRow.anon_key_exists === false, "SUCCESS row: metadata.anonymousAccess key absent (removed per MF15)");
    check(successRow.outbox_id !== null, "SUCCESS row: outbox_id IS NOT NULL (routed through outbox)");
  }
  check(outbox.length >= 2, "audit_outbox has rows for these actions (enqueued)");
  if (failedOutbox) {
    check(failedOutbox.status === "SENT", "FAILED outbox row: status = SENT (worker processed)");
    check(failedOutbox.user_id === ANONYMOUS_ACTOR_ID, "FAILED outbox row: userId = ANONYMOUS_ACTOR_ID");
    check(failedOutbox.actor_type === "ANONYMOUS", "FAILED outbox row: actorType = ANONYMOUS");
  }
  if (successOutbox) {
    check(successOutbox.status === "SENT", "SUCCESS outbox row: status = SENT (worker processed)");
    check(successOutbox.user_id === ANONYMOUS_ACTOR_ID, "SUCCESS outbox row: userId = ANONYMOUS_ACTOR_ID");
    check(successOutbox.actor_type === "ANONYMOUS", "SUCCESS outbox row: actorType = ANONYMOUS");
  }

  console.log(`\n${ok ? "✓ All checks passed" : "✗ Some checks FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
