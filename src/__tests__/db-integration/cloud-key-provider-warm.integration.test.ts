/**
 * Under a cloud KEY_PROVIDER `getMasterKeyByVersion` reads through
 * `getKeyProviderSync().getKeySync`, which throws for a version nobody fetched.
 * The audit-outbox worker and the webhook-secret migration run no app boot, so
 * each warms the versions it is about to use. The fake provider below is
 * stateful like the real cloud one: `getKeySync` serves only what `getKey`
 * already cached, so a missing warm call surfaces as "not in cache".
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

vi.mock("@/lib/key-provider/aws-sm-provider", () => {
  class AwsSmKeyProvider {
    readonly name = "aws-sm";
    private readonly cache = new Map<string, Buffer>();

    // Same env lookup as env-provider's share-master path, minus the fallback
    // the tests do not need.
    async getKey(name: string, version?: number): Promise<Buffer> {
      const v = version ?? 1;
      const hex =
        process.env[`SHARE_MASTER_KEY_V${v}`] ??
        (v === 1 ? process.env.SHARE_MASTER_KEY : undefined);
      if (name !== "share-master" || !hex) {
        throw new Error(`fake aws-sm: no key for ${name} v${v}`);
      }
      const key = Buffer.from(hex, "hex");
      this.cache.set(`${name}:${v}`, key);
      return key;
    }

    getKeySync(name: string, version?: number): Buffer {
      const key = this.cache.get(`${name}:${version ?? 1}`);
      if (!key) throw new Error(`fake aws-sm: ${name} v${version ?? 1} not in cache`);
      return key;
    }

    async validateKeys(): Promise<void> {}
  }
  return { AwsSmKeyProvider };
});

import {
  createPrismaForRole,
  createTestContext,
  setBypassRlsGucs,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import { _resetKeyProvider } from "@/lib/key-provider";
import { encryptServerData, getCurrentMasterKeyVersion } from "@/lib/crypto/crypto-server";
import { DELIVERERS } from "@/workers/audit-delivery";
import { processDeliveryBatch } from "@/workers/audit-outbox-worker";
import { migrateWebhookSecrets } from "@/../scripts/migrate-webhook-secrets-v1-to-v2";

// A version below the current one, so the row version is not covered merely
// by the current-version warm. The two versions are stubbed per test rather
// than read from the host: CI configures a single key (version 1 only).
const ROW_VERSION = 1;
const CURRENT_VERSION = 2;
const TEST_V2_KEY = "2".repeat(64);

function stubTwoKeyVersions(): void {
  const v1 = process.env.SHARE_MASTER_KEY_V1 || process.env.SHARE_MASTER_KEY;
  if (!v1) throw new Error("SHARE_MASTER_KEY (version 1) not set");
  vi.stubEnv("SHARE_MASTER_KEY_V1", v1);
  vi.stubEnv("SHARE_MASTER_KEY_V2", TEST_V2_KEY);
  vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", String(CURRENT_VERSION));
}

function envKey(version: number): Buffer {
  const hex = process.env[`SHARE_MASTER_KEY_V${version}`];
  if (!hex) throw new Error(`SHARE_MASTER_KEY_V${version} not set`);
  return Buffer.from(hex, "hex");
}

describe("cloud KEY_PROVIDER: out-of-app processes warm the keys they use", () => {
  let ctx: TestContext;
  let wp: PrismaWithPool;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    wp = createPrismaForRole("worker", { max: 1 });
  });
  afterAll(async () => {
    await wp?.prisma.$disconnect();
    await wp?.pool.end();
    await ctx?.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    _resetKeyProvider();
    stubTwoKeyVersions();
    // The cells prove the row version is warmed in its own right; that is vacuous
    // if the current-version warm would have covered it anyway.
    expect(getCurrentMasterKeyVersion()).not.toBe(ROW_VERSION);
    vi.stubEnv("KEY_PROVIDER", "aws-sm");
    vi.stubEnv("AWS_REGION", "us-east-1");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    _resetKeyProvider();
    await ctx.deleteTestData(tenantId);
  });

  it("decrypts an audit delivery target config without an app boot", async () => {
    const outboxId = randomUUID();
    const targetId = randomUUID();
    const deliveryId = randomUUID();
    const config = { url: "https://example.com/hook", secret: "warm-secret" };
    const aad = Buffer.concat([
      Buffer.from(targetId.replace(/-/g, ""), "hex"),
      Buffer.from(tenantId.replace(/-/g, ""), "hex"),
    ]);
    const enc = encryptServerData(JSON.stringify(config), envKey(ROW_VERSION), aad);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', now())`,
        outboxId,
        tenantId,
        JSON.stringify({
          scope: "PERSONAL",
          action: "ENTRY_CREATE",
          userId,
          actorType: "HUMAN",
        }),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_delivery_targets (
           id, tenant_id, kind, config_encrypted, config_iv, config_auth_tag,
           master_key_version, is_active, created_at
         ) VALUES ($1::uuid, $2::uuid, 'WEBHOOK', $3, $4, $5, $6, true, now())`,
        targetId,
        tenantId,
        enc.ciphertext,
        enc.iv,
        enc.authTag,
        ROW_VERSION,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_deliveries (id, outbox_id, target_id, tenant_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        deliveryId,
        outboxId,
        targetId,
        tenantId,
      );
    });

    const deliver = vi.spyOn(DELIVERERS.WEBHOOK, "deliver").mockResolvedValue(undefined);

    await processDeliveryBatch(wp.prisma, 50);

    // The deliverer saw the decrypted config, so the sync key read succeeded.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject(config);

    const [row] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM audit_deliveries WHERE id = $1::uuid`,
        deliveryId,
      );
    });
    expect(row.status).toBe("SENT");
  });

  it("migrates v1 webhook secrets without an app boot", async () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", envKey(ROW_VERSION), iv, {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([cipher.update("v1-secret", "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const teamId = randomUUID();
    const webhookId = randomUUID();

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'warm-mig-team', $3, now(), now())`,
        teamId,
        tenantId,
        `warm-mig-${teamId.slice(0, 8)}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO team_webhooks (
           id, tenant_id, team_id, url, events, is_active,
           secret_encrypted, secret_iv, secret_auth_tag,
           master_key_version, secret_aad_version, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'https://example.com/h',
           ARRAY[]::text[], true, $4, $5, $6, $7, 1, now(), now()
         )`,
        webhookId,
        tenantId,
        teamId,
        ciphertext.toString("hex"),
        iv.toString("hex"),
        authTag.toString("hex"),
        ROW_VERSION,
      );
    });

    const stats = await migrateWebhookSecrets(ctx.app.prisma, { dryRun: false });

    expect(stats.teamRowsMigrated).toBeGreaterThan(0);
    expect(stats.teamRowsSkipped).toBe(0);
    expect(stats.tenantRowsSkipped).toBe(0);

    const [row] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ secret_aad_version: number }>>(
        `SELECT secret_aad_version FROM team_webhooks WHERE id = $1::uuid`,
        webhookId,
      );
    });
    expect(row.secret_aad_version).toBe(2);
  });
});
