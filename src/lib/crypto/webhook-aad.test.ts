import { describe, it, expect } from "vitest";
import {
  buildWebhookSecretAAD,
  WEBHOOK_SECRET_AAD_VERSION_CURRENT,
} from "./webhook-aad";
import { encryptServerData, decryptServerData } from "./crypto-server";

const WEBHOOK_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WEBHOOK_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TENANT_ID = "44444444-4444-4444-8444-444444444444";
const TEAM_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_TEAM_ID = "66666666-6666-4666-8666-666666666666";
const MASTER_KEY = Buffer.alloc(32, 0xab);
const PLAINTEXT = "the-webhook-hmac-secret-32-bytes-hex";

describe("buildWebhookSecretAAD — shape", () => {
  it("produces deterministic AAD for the same args", () => {
    const a = buildWebhookSecretAAD({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const b = buildWebhookSecretAAD({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    expect(a.equals(b)).toBe(true);
  });

  it("differs by tableName (S8: cross-table swap blocked)", () => {
    const tenant = buildWebhookSecretAAD({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const team = buildWebhookSecretAAD({
      tableName: "TeamWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
    });
    expect(tenant.equals(team)).toBe(false);
  });

  it("differs by version (S9: downgrade oracle blocked)", () => {
    const v2 = buildWebhookSecretAAD({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const v3 = buildWebhookSecretAAD({
      tableName: "TenantWebhook",
      version: 3,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    expect(v2.equals(v3)).toBe(false);
  });

  it("rejects malformed UUIDs in webhookId (F14)", () => {
    expect(() =>
      buildWebhookSecretAAD({
        tableName: "TenantWebhook",
        version: 2,
        webhookId: "not-a-uuid",
        tenantId: TENANT_ID,
      }),
    ).toThrow(/webhookId/);
  });

  it("rejects TeamWebhook without teamId", () => {
    expect(() =>
      buildWebhookSecretAAD({
        tableName: "TeamWebhook",
        version: 2,
        webhookId: WEBHOOK_ID,
        tenantId: TENANT_ID,
      }),
    ).toThrow(/teamId/);
  });

  it("rejects TenantWebhook with a teamId", () => {
    expect(() =>
      buildWebhookSecretAAD({
        tableName: "TenantWebhook",
        version: 2,
        webhookId: WEBHOOK_ID,
        tenantId: TENANT_ID,
        teamId: TEAM_ID,
      }),
    ).toThrow(/must not have a teamId/);
  });

  it("rejects non-positive version", () => {
    expect(() =>
      buildWebhookSecretAAD({
        tableName: "TenantWebhook",
        version: 0,
        webhookId: WEBHOOK_ID,
        tenantId: TENANT_ID,
      }),
    ).toThrow(/positive integer/);
  });
});

describe("AES-GCM round-trip with AAD", () => {
  function aad(args: Parameters<typeof buildWebhookSecretAAD>[0]) {
    return buildWebhookSecretAAD(args);
  }

  it("round-trips with matching AAD", () => {
    const a = aad({
      tableName: "TenantWebhook",
      version: WEBHOOK_SECRET_AAD_VERSION_CURRENT,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const enc = encryptServerData(PLAINTEXT, MASTER_KEY, a);
    const dec = decryptServerData(enc, MASTER_KEY, a);
    expect(dec).toBe(PLAINTEXT);
  });

  it("fails on row swap: encrypt for webhook A, decrypt with webhook B's AAD (S8 intra-tenant)", () => {
    const aadA = aad({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const aadB = aad({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: OTHER_WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const enc = encryptServerData(PLAINTEXT, MASTER_KEY, aadA);
    expect(() => decryptServerData(enc, MASTER_KEY, aadB)).toThrow();
  });

  it("fails on cross-table swap: encrypt as TenantWebhook, decrypt as TeamWebhook (S8)", () => {
    const aadTenant = aad({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const aadTeam = aad({
      tableName: "TeamWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
    });
    const enc = encryptServerData(PLAINTEXT, MASTER_KEY, aadTenant);
    expect(() => decryptServerData(enc, MASTER_KEY, aadTeam)).toThrow();
  });

  it("fails on cross-tenant swap (S8)", () => {
    const aadA = aad({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const aadB = aad({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: OTHER_TENANT_ID,
    });
    const enc = encryptServerData(PLAINTEXT, MASTER_KEY, aadA);
    expect(() => decryptServerData(enc, MASTER_KEY, aadB)).toThrow();
  });

  it("fails on version downgrade: encrypt at v2 but decrypt with v1 AAD-less path (S9)", () => {
    const aadV2 = aad({
      tableName: "TenantWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
    });
    const enc = encryptServerData(PLAINTEXT, MASTER_KEY, aadV2);
    // Simulate v2→v1 downgrade attack: column flipped to 1 routes the
    // decrypt branch to the no-AAD path. The GCM tag was bound to v2 AAD,
    // so the legacy path's empty-AAD verification fails.
    expect(() => decryptServerData(enc, MASTER_KEY)).toThrow();
  });

  it("blocks cross-team swap within same tenant (S8)", () => {
    const aadA = aad({
      tableName: "TeamWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
    });
    const aadB = aad({
      tableName: "TeamWebhook",
      version: 2,
      webhookId: WEBHOOK_ID,
      tenantId: TENANT_ID,
      teamId: OTHER_TEAM_ID,
    });
    const enc = encryptServerData(PLAINTEXT, MASTER_KEY, aadA);
    expect(() => decryptServerData(enc, MASTER_KEY, aadB)).toThrow();
  });
});
