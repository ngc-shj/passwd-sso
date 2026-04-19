/**
 * Manual E2E test: MCP refresh-token replay → audit row shape verification.
 *
 * Verifies that when a refresh token is replayed (re-used after rotation), the
 * MCP_REFRESH_TOKEN_REPLAY audit row carries the expected forensic fields:
 *   - userId    = SYSTEM_ACTOR_ID  (regression guard for the NIL_UUID bug fixed in 0.4.44)
 *   - actorType = SYSTEM           (regression guard for the implicit HUMAN default bug)
 *   - ip + userAgent populated     (regression guard for the missing tenantAuditBase use)
 *   - metadata.familyId            (the rotation-family identifier)
 *
 * Prerequisites:
 *   - dev server running (default: https://localhost:3001/passwd-sso; override with BASE_URL env)
 *   - postgres up via docker compose
 *   - .env.local with MIGRATION_DATABASE_URL pointing to a SUPERUSER role
 *     (passwd_user) — the script seeds an MCP client + initial token row, which
 *     RLS would block under the regular passwd_app role.
 *   - At least one tenant + one user in the DB.
 *
 * Usage:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx scripts/manual-tests/mcp-replay-audit-verification.ts
 *
 * The script seeds a temporary MCP client + tokens, exercises rotate + replay,
 * verifies the audit row shape, then deletes the test fixture (try/finally).
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

// MIGRATION_DATABASE_URL connects as passwd_user (SUPERUSER) to bypass RLS for
// seed/cleanup. The actual audit row under verification is still written by the
// API process running as passwd_app — only the test fixture rows need elevated
// access.
const adapter = new PrismaPg({ connectionString: process.env.MIGRATION_DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const BASE = process.env.BASE_URL ?? "https://localhost:3001/passwd-sso";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000001";

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

async function withTenantRls<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.bypass_purpose', 'TOKEN_LIFECYCLE', true)`;
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn();
  });
}

async function postTokenForm(body: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}/api/mcp/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "test-replay-script/1.0",
    },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  console.log("=== MCP refresh-token replay → audit row verification ===\n");

  // Pick any tenant + a user from that tenant
  const tenant = await withTenantRls(NIL_UUID, () =>
    prisma.tenant.findFirst({ orderBy: { createdAt: "asc" } })
  );
  if (!tenant) throw new Error("No tenants in DB — seed required");
  console.log("Tenant:", tenant.id, tenant.slug);

  const user = await withTenantRls(tenant.id, () =>
    prisma.user.findFirst({ where: { tenantId: tenant.id } })
  );
  if (!user) throw new Error(`No user found for tenant ${tenant.id}`);
  console.log("User:", user.id);

  // Seed: MCP client + initial access/refresh token pair
  const clientIdStr = "mcpc_" + randomBytes(16).toString("hex");
  const clientSecret = "mcps_" + randomBytes(32).toString("hex");
  const refreshTokenStr = "mcpr_" + randomBytes(32).toString("base64url");
  const accessTokenStr = "mcpa_" + randomBytes(32).toString("base64url");
  const familyId = randomUUID();

  const client = await withTenantRls(tenant.id, () =>
    prisma.mcpClient.create({
      data: {
        tenantId: tenant.id,
        clientId: clientIdStr,
        clientSecretHash: hashToken(clientSecret),
        name: "test-replay-" + Date.now(),
        redirectUris: ["http://localhost/callback"],
        allowedScopes: "vault:status",
      },
    })
  );

  try {
    const access = await withTenantRls(tenant.id, () =>
      prisma.mcpAccessToken.create({
        data: {
          tokenHash: hashToken(accessTokenStr),
          clientId: client.id,
          tenantId: tenant.id,
          userId: user.id,
          scope: "vault:status",
          expiresAt: new Date(Date.now() + 3600_000),
        },
      })
    );
    await withTenantRls(tenant.id, () =>
      prisma.mcpRefreshToken.create({
        data: {
          tokenHash: hashToken(refreshTokenStr),
          familyId,
          accessTokenId: access.id,
          clientId: client.id,
          tenantId: tenant.id,
          userId: user.id,
          scope: "vault:status",
          expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
        },
      })
    );
    console.log("Seeded MCP client + initial refresh token (familyId =", familyId + ")\n");

    // Step 1: rotate (success — produces a new pair, marks old as used)
    const rotate = await postTokenForm({
      grant_type: "refresh_token",
      refresh_token: refreshTokenStr,
      client_id: clientIdStr,
      client_secret: clientSecret,
    });
    console.log(`Rotate response: HTTP ${rotate.status}`);
    if (rotate.status !== 200) {
      throw new Error(`First rotate failed: ${rotate.body}`);
    }

    // Step 2: REPLAY — re-use the OLD (now-rotated-out) refresh token
    const replay = await postTokenForm({
      grant_type: "refresh_token",
      refresh_token: refreshTokenStr,
      client_id: clientIdStr,
      client_secret: clientSecret,
    });
    console.log(`Replay response: HTTP ${replay.status}  body: ${replay.body}`);
    if (replay.status !== 400 || !replay.body.includes("invalid_grant")) {
      throw new Error(`Expected 400 invalid_grant, got ${replay.status} ${replay.body}`);
    }

    // Step 3: wait briefly for outbox worker to drain into audit_logs
    console.log("\nWaiting 2s for audit_outbox → audit_logs propagation...");
    await new Promise((r) => setTimeout(r, 2000));

    const logRows = await withTenantRls(tenant.id, () =>
      prisma.auditLog.findMany({
        where: { tenantId: tenant.id, action: "MCP_REFRESH_TOKEN_REPLAY" },
        orderBy: { createdAt: "desc" },
        take: 1,
      })
    );

    // Fall back to outbox if worker hasn't drained yet
    let row: { userId: string; actorType: string; ip: string | null; userAgent: string | null; metadata: unknown };
    if (logRows.length > 0) {
      row = logRows[0];
      console.log("\nVerified against audit_logs (worker drained).");
    } else {
      const outboxRows = await withTenantRls(tenant.id, () =>
        prisma.auditOutbox.findMany({
          where: {
            tenantId: tenant.id,
            payload: { path: ["action"], equals: "MCP_REFRESH_TOKEN_REPLAY" },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        })
      );
      if (outboxRows.length === 0) {
        throw new Error("Neither audit_outbox nor audit_logs has the replay row");
      }
      const payload = outboxRows[0].payload as {
        userId: string;
        actorType: string;
        ip: string | null;
        userAgent: string | null;
        metadata: unknown;
      };
      row = payload;
      console.log("\nVerified against audit_outbox payload (worker not yet drained).");
    }

    console.log("  userId     =", row.userId);
    console.log("  actorType  =", row.actorType);
    console.log("  ip         =", row.ip);
    console.log("  userAgent  =", row.userAgent);
    console.log("  metadata   =", JSON.stringify(row.metadata));

    const checks = [
      { name: "userId === SYSTEM_ACTOR_ID", pass: row.userId === SYSTEM_ACTOR_ID, got: row.userId },
      { name: "userId !== NIL_UUID (regression guard)", pass: row.userId !== NIL_UUID, got: row.userId },
      { name: "actorType === SYSTEM", pass: row.actorType === "SYSTEM", got: row.actorType },
      { name: "ip is non-null (tenantAuditBase capture)", pass: row.ip !== null, got: row.ip },
      { name: "userAgent is non-null (tenantAuditBase capture)", pass: row.userAgent !== null, got: row.userAgent },
      {
        name: "metadata.familyId matches",
        pass: row.metadata != null && (row.metadata as { familyId?: string }).familyId === familyId,
        got: row.metadata,
      },
    ];
    console.log("\nChecks:");
    for (const c of checks) {
      console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}` + (c.pass ? "" : ` (got: ${JSON.stringify(c.got)})`));
    }
    const allPass = checks.every((c) => c.pass);
    console.log(allPass ? "\n✅ PASS" : "\n❌ FAIL");
    if (!allPass) process.exitCode = 1;
  } finally {
    // Always clean up — even if assertions failed
    await withTenantRls(tenant.id, async () => {
      await prisma.mcpRefreshToken.deleteMany({ where: { clientId: client.id } });
      await prisma.mcpAccessToken.deleteMany({ where: { clientId: client.id } });
      await prisma.mcpClient.delete({ where: { id: client.id } });
    });
    console.log("\n(test data cleaned up)");
  }
}

main()
  .catch((err) => {
    console.error("\nERROR:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
