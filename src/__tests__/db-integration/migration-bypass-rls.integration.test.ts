/**
 * The one-shot migrations must see their rows from a role that is
 * NOSUPERUSER + NOBYPASSRLS — i.e. an ordinary AWS RDS master.
 *
 * `rds_superuser` is a role MEMBERSHIP, not a role ATTRIBUTE. RDS creates the
 * master as NOSUPERUSER, and BYPASSRLS defaults to NOBYPASSRLS when
 * unspecified, so `rolsuper`/`rolbypassrls` are both false there. Every table
 * these migrations rewrite is FORCE ROW LEVEL SECURITY, whose policy admits on
 *
 *   COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
 *     OR tenant_id = current_setting('app.tenant_id', true)::uuid
 *
 * so what decides visibility is the GUC, which any role may set. That is why
 * the migrations run inside `withBypassRls` rather than gating on a role
 * attribute — `scripts/tenant-domain.ts` documents the identical hazard for
 * `tenant_claims`.
 *
 * `ctx.app` (`passwd_app`) is the RDS-equivalent principal here: NOSUPERUSER,
 * NOBYPASSRLS, and holding DML on these tables. A superuser client would
 * bypass RLS outright and pass even if the wrapping were removed.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { migrateWebhookSecrets } from "@/../scripts/migrate-webhook-secrets-v1-to-v2";

describe("one-shot migrations under an RDS-equivalent role", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("confirms the app role really is NOSUPERUSER and NOBYPASSRLS", async () => {
    // The premise. If passwd_app ever gained either attribute, the cases below
    // would pass by bypassing RLS rather than by setting the GUC, and would
    // stop testing what they claim.
    const [row] = await ctx.app.prisma.$queryRawUnsafe<
      Array<{ is_superuser: boolean; bypasses_rls: boolean }>
    >(
      `SELECT rolsuper AS is_superuser, rolbypassrls AS bypasses_rls
       FROM pg_roles WHERE rolname = current_user`,
    );
    expect(row.is_superuser).toBe(false);
    expect(row.bypasses_rls).toBe(false);
  });

  it("sees zero v1 webhook rows without a bypass context — the silent failure", async () => {
    // Control clause: this is what the migration did before, and it raises
    // nothing. Without it, the passing case below could pass for a stale
    // reason (e.g. the fixture never landed).
    await seedV1TeamWebhook();

    const bare = await ctx.app.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT id FROM team_webhooks WHERE tenant_id = $1`,
      tenantId,
    );
    expect(bare).toHaveLength(0);

    const truth = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*) AS count FROM team_webhooks WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    expect(Number(truth[0].count)).toBe(1);
  });

  it("migrates the row as passwd_app, because the GUC is what grants visibility", async () => {
    // Allow side, and the whole point: no role attribute changed, only the
    // bypass transaction the migration now opens.
    const webhookId = await seedV1TeamWebhook();

    const stats = await migrateWebhookSecrets(ctx.app.prisma, {
      dryRun: false,
    });

    // migrateWebhookSecrets sweeps the whole table, so on a shared dev DB the
    // aggregate picks up other tenants' stale v1 rows. Assert on THIS row, and
    // only that the sweep saw at least ours.
    expect(stats.teamRowsMigrated).toBeGreaterThanOrEqual(1);

    const [row] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ secret_aad_version: number }>>(
        `SELECT secret_aad_version FROM team_webhooks WHERE id = $1::uuid`,
        webhookId,
      );
    });
    // The row was actually rewritten, not merely counted.
    expect(row.secret_aad_version).toBe(2);
  });

  /** A v1 (no-AAD) team webhook whose secret decrypts under the current key. */
  async function seedV1TeamWebhook(): Promise<string> {
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const { getCurrentMasterKeyVersion, getMasterKeyByVersion } = await import(
      "@/lib/crypto/crypto-server"
    );
    const version = getCurrentMasterKeyVersion();
    const key = getMasterKeyByVersion(version);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([
      cipher.update("v1-secret", "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const teamId = randomUUID();
    const webhookId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'rls-mig-team', $3, now(), now())`,
        teamId,
        tenantId,
        `rls-mig-${teamId.slice(0, 8)}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO team_webhooks (
           id, tenant_id, team_id, url, events, is_active,
           secret_encrypted, secret_iv, secret_auth_tag,
           master_key_version, secret_aad_version, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'https://example.com/h',
           ARRAY[]::text[], true,
           $4, $5, $6, $7, 1, now(), now()
         )`,
        webhookId,
        tenantId,
        teamId,
        ciphertext.toString("hex"),
        iv.toString("hex"),
        authTag.toString("hex"),
        version,
      );
    });
    return webhookId;
  }
});
