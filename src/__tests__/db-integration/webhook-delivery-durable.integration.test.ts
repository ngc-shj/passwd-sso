/**
 * Real-DB integration tests for the durable webhook-delivery pipeline
 * (EXT-2 follow-up — see docs/archive/review/webhook-durable-delivery-plan.md).
 *
 * Split into two halves that mirror the production call graph:
 *   - Enqueue side: `deliverRow` (non-chain path) and `deliverRowWithChain`
 *     (both exported) commit the audit_logs row AND enqueue exactly one
 *     `webhook_deliveries` work item inside the same winning tx (INV-W1/INV-W2).
 *   - Delivery side: `processWebhookDeliveryBatch` (exported) claims the work
 *     item and drives the real fan-out core `deliverToWebhookRecords`
 *     (webhook-dispatcher.ts) — resolving the LIVE subscriber rows, computing
 *     the dual HMAC signatures, and delivering against a local mock server.
 *     T-obs/T-crash and T-nonchain drive this full exported primitive
 *     end-to-end (claim → subscriber resolve → deliver → mark SENT). T-adj
 *     drives `deliverToWebhookRecords` directly (against subscriber rows
 *     resolved the same way `resolveWebhookSubscribers` does) to observe the
 *     AAD fail-closed path in isolation.
 *
 * SSRF note (see report): `resolveAndValidateIps` rejects loopback (127.0.0.0/8
 * is in BLOCKED_CIDRS) — and every real network-reachable address on the test
 * host (192.168/16, tailscale 100.64/10 CGNAT, docker 172.17-20/16) is ALSO
 * blocked by design. There is no real IP that both reaches a local mock server
 * and passes SSRF validation. We therefore mock ONLY `resolveAndValidateIps`
 * (keeping `createPinnedDispatcher`, `sanitizeForExternalDelivery`, and every
 * other module real via importOriginal) to return the mock server's loopback
 * address — this is the minimal boundary needed to drive the real delivery
 * core, HMAC signing, and AAD decrypt end-to-end against an observable server.
 *
 * Shared-DB note: a live docker audit-outbox-worker may be draining rows
 * concurrently. Every assertion below is scoped to a test-created tenant and
 * a specific outbox_id/webhook_deliveries id — never a global COUNT(*) or a
 * purge-count delta. Each test binds its own mock HTTP server on an
 * OS-assigned port, so a stray background delivery for the same action/tenant
 * (there should be none, since tenants are freshly created per test) still
 * cannot land on another test's server.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { AUDIT_ACTION, AUDIT_SCOPE, ACTOR_TYPE, AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { enqueueAuditInTx, type AuditOutboxPayload } from "@/lib/audit/audit-outbox";
import {
  deliverRow,
  deliverRowWithChain,
  processWebhookDeliveryBatch,
  checkChainEnabled,
  reapStuckWebhookDeliveries,
  purgeRetention,
  type AuditOutboxRow,
} from "@/workers/audit-outbox-worker";
import { encryptServerData, getMasterKeyByVersion } from "@/lib/crypto/crypto-server";
import { buildWebhookSecretAAD } from "@/lib/crypto/webhook-aad";

// ─── SSRF boundary mock (see file-header note) ──────────────────────────────

let mockServerPort = 0;

vi.mock("@/lib/http/external-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/external-http")>();
  return {
    ...actual,
    // Loopback is unconditionally blocked by isPrivateIp/BLOCKED_CIDRS, and no
    // other real address on this host passes validation either (see header
    // note). Redirect validation to whatever port the test's mock server is
    // currently bound to, so createPinnedDispatcher (kept real) connects
    // straight to it.
    resolveAndValidateIps: vi.fn(async () => ["127.0.0.1"]),
  };
});

// ─── deliverToWebhookRecords indirection (T-deadletter only) ────────────────
//
// deliverToWebhookRecords is REAL by default (delegates to the actual
// implementation) so T-obs / T-adj exercise the true delivery core, HMAC
// signing, and AAD decrypt. A single test (T-deadletter) swaps in a throwing
// impl to induce the work-item infra-failure branch of processOneWebhookDelivery
// → recordWebhookDeliveryError. This is the same module the worker imports, so
// the override reaches the production processWebhookDeliveryBatch path too.
type DeliverFn = typeof import("@/lib/webhook-dispatcher").deliverToWebhookRecords;
let deliverToWebhookRecordsImpl: DeliverFn | null = null;

vi.mock("@/lib/webhook-dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhook-dispatcher")>();
  return {
    ...actual,
    deliverToWebhookRecords: ((...args: Parameters<DeliverFn>) =>
      (deliverToWebhookRecordsImpl ?? actual.deliverToWebhookRecords)(...args)) as DeliverFn,
  };
});

// ─── Mock webhook receiver server ───────────────────────────────────────────

interface ReceivedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startMockServer(): Promise<{ server: http.Server; port: number; received: ReceivedRequest[] }> {
  const received: ReceivedRequest[] = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port, received });
    });
    server.on("error", reject);
  });
}

function stopMockServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeOutboxPayload(overrides: Partial<AuditOutboxPayload> = {}, userId: string): AuditOutboxPayload {
  return {
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
    userId,
    actorType: ACTOR_TYPE.HUMAN,
    serviceAccountId: null,
    teamId: null,
    targetType: null,
    targetId: null,
    metadata: { note: "integration-test" },
    ip: "127.0.0.1",
    userAgent: "integration-test",
    ...overrides,
  } as AuditOutboxPayload;
}

/** Enqueue a real audit_outbox row via the production helper and read it back. */
async function enqueueOutboxRow(
  ctx: TestContext,
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<AuditOutboxRow> {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await enqueueAuditInTx(tx, tenantId, payload);
  });
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<AuditOutboxRow[]>(
      `SELECT id, tenant_id, payload, status, attempt_count, max_attempts,
              created_at, next_retry_at, processing_started_at, sent_at, last_error
       FROM audit_outbox WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      tenantId,
    );
  });
  const row = rows[0];
  if (!row) throw new Error("outbox row not found after enqueue");
  return row;
}

/** Encrypt a v2-AAD-bound webhook secret matching buildWebhookSecretAAD's contract. */
function encryptWebhookSecret(args: {
  kind: "TenantWebhook" | "TeamWebhook";
  webhookId: string;
  tenantId: string;
  teamId?: string | null;
  masterKeyVersion: number;
  secretAadVersion: number;
  secret: string;
}) {
  const masterKey = getMasterKeyByVersion(args.masterKeyVersion);
  const aad = buildWebhookSecretAAD({
    tableName: args.kind,
    version: args.secretAadVersion,
    webhookId: args.webhookId,
    tenantId: args.tenantId,
    teamId: args.kind === "TeamWebhook" ? args.teamId ?? null : undefined,
  });
  return encryptServerData(args.secret, masterKey, aad);
}

async function createTenantWebhook(
  ctx: TestContext,
  opts: {
    tenantId: string;
    url: string;
    events: string[];
    isActive?: boolean;
    secretAadVersion?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const masterKeyVersion = 1;
  const secretAadVersion = opts.secretAadVersion ?? 2;
  const enc = encryptWebhookSecret({
    kind: "TenantWebhook",
    webhookId: id,
    tenantId: opts.tenantId,
    masterKeyVersion,
    secretAadVersion,
    secret: "test-webhook-secret",
  });
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO tenant_webhooks
         (id, tenant_id, url, secret_encrypted, secret_iv, secret_auth_tag,
          master_key_version, secret_aad_version, events, is_active,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::text[], $10, now(), now())`,
      id,
      opts.tenantId,
      opts.url,
      enc.ciphertext,
      enc.iv,
      enc.authTag,
      masterKeyVersion,
      secretAadVersion,
      opts.events,
      opts.isActive ?? true,
    );
  });
  return id;
}

async function createTeam(ctx: TestContext, tenantId: string): Promise<string> {
  const id = randomUUID();
  const slug = `t-${id.slice(0, 8)}`;
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 1, now(), now())`,
      id,
      tenantId,
      "integration-test-team",
      slug,
    );
  });
  return id;
}

async function createTeamWebhook(
  ctx: TestContext,
  opts: {
    tenantId: string;
    teamId: string;
    url: string;
    events: string[];
    isActive?: boolean;
    secretAadVersion?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const masterKeyVersion = 1;
  const secretAadVersion = opts.secretAadVersion ?? 2;
  const enc = encryptWebhookSecret({
    kind: "TeamWebhook",
    webhookId: id,
    tenantId: opts.tenantId,
    teamId: opts.teamId,
    masterKeyVersion,
    secretAadVersion,
    secret: "test-webhook-secret",
  });
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `INSERT INTO team_webhooks
         (id, team_id, tenant_id, url, secret_encrypted, secret_iv, secret_auth_tag,
          master_key_version, secret_aad_version, events, is_active,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::text[], $11, now(), now())`,
      id,
      opts.teamId,
      opts.tenantId,
      opts.url,
      enc.ciphertext,
      enc.iv,
      enc.authTag,
      masterKeyVersion,
      secretAadVersion,
      opts.events,
      opts.isActive ?? true,
    );
  });
  return id;
}

/**
 * Park a webhook_deliveries row far in the future so the LIVE docker worker
 * (a separate process without this test's resolveAndValidateIps mock) cannot
 * claim it — its claim query filters on `next_retry_at <= now()`. Tests that
 * drive processWebhookDeliveryBatch themselves flip it back to now() in the
 * same process microseconds before their own claim, keeping the race window
 * far tighter than the worker's ~1s poll interval.
 */
async function parkDeliveryRow(ctx: TestContext, deliveryId: string, seconds: number): Promise<void> {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE webhook_deliveries SET next_retry_at = now() + make_interval(secs => $1) WHERE id = $2::uuid`,
      seconds,
      deliveryId,
    );
  });
}

async function unparkDeliveryRow(ctx: TestContext, deliveryId: string): Promise<void> {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE webhook_deliveries SET next_retry_at = now() WHERE id = $1::uuid`,
      deliveryId,
    );
  });
}

async function readWebhookDeliveryRowsByOutboxId(ctx: TestContext, outboxId: string) {
  return ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<
      { id: string; status: string; scope: string; team_id: string | null; attempt_count: number; max_attempts: number }[]
    >(
      `SELECT id, status, scope::text AS scope, team_id, attempt_count, max_attempts
       FROM webhook_deliveries WHERE outbox_id = $1::uuid`,
      outboxId,
    );
  });
}


// ─── Suite ───────────────────────────────────────────────────────────────────

describe("webhook delivery — durable pipeline (real DB + real delivery core)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let server: http.Server;
  let port: number;
  let received: ReceivedRequest[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    const started = await startMockServer();
    server = started.server;
    port = started.port;
    received = started.received;
    mockServerPort = port;
  });

  afterEach(async () => {
    // Restore the real delivery core in case a test overrode it (T-deadletter).
    deliverToWebhookRecordsImpl = null;
    await stopMockServer(server);
    await ctx.deleteTestData(tenantId);
  });

  function mockUrl(): string {
    return `http://127.0.0.1:${mockServerPort}/hook`;
  }

  // ── T-obs / T-crash: enqueue commits a durable PENDING row; the REAL exported
  // processWebhookDeliveryBatch then claims it and drives the full delivery
  // primitive end-to-end (claim → subscriber resolve → deliver → mark SENT).
  // T-crash's "separately run the delivery batch" is modeled faithfully: the
  // enqueue tx (deliverRowWithChain) and the delivery pass are distinct calls,
  // so a crash between them would leave a durable PENDING row this pass recovers.
  it("T-obs/T-crash: enqueue produces a durable PENDING row, processWebhookDeliveryBatch POSTs to the live subscriber with a valid signature, and transitions the row PENDING→SENT", async () => {
    await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.delivered).toBe(true);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("PENDING");
    expect(deliveries[0].scope).toBe("TENANT");

    // Park the row so the bg docker worker (no resolveAndValidateIps mock →
    // would SSRF-block our loopback URL and mark the row SENT without hitting
    // our server) cannot claim it; unpark + claim it ourselves in-process,
    // driving the REAL exported delivery primitive.
    await parkDeliveryRow(ctx, deliveries[0].id, 3600);
    await unparkDeliveryRow(ctx, deliveries[0].id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    // Observed HTTP fan-out: the real primitive resolved the live subscriber,
    // computed the dual HMAC, and POSTed to the mock server.
    expect(received).toHaveLength(1);
    expect(received[0].headers["x-webhook-signature"]).toMatch(/^t=.+,v1=[0-9a-f]{64}$/);
    const sentBody = JSON.parse(received[0].body);
    expect(sentBody.type).toBe(AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE);

    // The work item transitioned PENDING→SENT via the real markWebhookDeliverySent
    // inside processWebhookDeliveryBatch — asserted by id, not a count delta.
    const after = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(deliveries[0].id);
    expect(after[0].status).toBe("SENT");
  });

  // ── W-1 fresh-timestamp: a delivery whose source outbox row was created WELL
  // past the ±5min anti-replay window must still sign with the DISPATCH time
  // (new Date()), not outbox.created_at — otherwise a spec-compliant receiver
  // would reject the delayed delivery as a replay. Age created_at to now-1h,
  // then drive the REAL processWebhookDeliveryBatch and assert the signed
  // X-Webhook-Timestamp is within 5min of now.
  it("W-1: a delayed delivery (outbox created_at = now-1h) signs with fresh dispatch time, not the stale created_at", async () => {
    await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);

    // Age the source outbox row far past the ±5min replay window. The delivery
    // reads created_at from audit_outbox — this is the value that MUST NOT leak
    // into the signature timestamp.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET created_at = now() - make_interval(hours => 1) WHERE id = $1::uuid`,
        row.id,
      );
    });

    await parkDeliveryRow(ctx, deliveries[0].id, 3600);
    await unparkDeliveryRow(ctx, deliveries[0].id);
    const dispatchStart = Date.now();
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    expect(received).toHaveLength(1);

    // The signed timestamp appears in BOTH X-Webhook-Timestamp and the
    // `t=<ts>` component of X-Webhook-Signature — assert both are fresh.
    const headerTs = received[0].headers["x-webhook-timestamp"] as string;
    expect(headerTs).toBeDefined();
    const sig = received[0].headers["x-webhook-signature"] as string;
    const sigTsMatch = sig.match(/^t=([^,]+),v1=[0-9a-f]{64}$/);
    expect(sigTsMatch).not.toBeNull();
    const sigTs = sigTsMatch![1];
    expect(sigTs).toBe(headerTs);

    // Fresh dispatch time: within 5min of now (and specifically after the aged
    // created_at, which was 1h ago). A stale created_at would be ~1h off.
    const signedMs = Date.parse(headerTs);
    expect(Math.abs(Date.now() - signedMs)).toBeLessThan(5 * 60 * 1000);
    // Tighter: the signed time is at/after the moment we started dispatch.
    expect(signedMs).toBeGreaterThanOrEqual(dispatchStart - 1000);
  });

  // ── T-dedup (INV-W1, non-vacuous): first delivery wins + enqueues; a
  // simulated reaper re-delivery (row reset to PENDING, webhook_deliveries row
  // still present) must NOT re-enqueue — asserted via BOTH the {inserted}
  // discriminator AND the row count staying at 1.
  it("T-dedup: deliverRowWithChain enqueues exactly once; a reaper-style re-delivery reports inserted=false and does not add a second webhook_deliveries row (INV-W1)", async () => {
    await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);

    const first = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(first.inserted).toBe(true);
    expect(first.delivered).toBe(true);

    const afterFirst = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(afterFirst).toHaveLength(1);

    // Simulate a reaper re-claim: reset the outbox row back to PENDING (the
    // webhook_deliveries row is untouched — still PENDING from the first call).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'PENDING', processing_started_at = NULL WHERE id = $1::uuid`,
        row.id,
      );
    });

    const second = await deliverRowWithChain(ctx.su.prisma, row, payload);
    // audit_logs ON CONFLICT (outbox_id) DO NOTHING — the second call is not
    // the winner, so it must not re-enqueue.
    expect(second.inserted).toBe(false);
    expect(second.delivered).toBe(true);

    const afterSecond = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
  });

  // ── T-events (delivery-time semantics): a webhook subscribed at enqueue time
  // that loses its subscription (events cleared / isActive=false) BEFORE
  // delivery must receive ZERO deliveries, even though the work item still
  // exists and the delivery pass can mark it terminal.
  // Both sub-cases drive the REAL exported processWebhookDeliveryBatch (with the
  // T-obs park/unpark shared-DB mitigation), so the delivery-time subscriber
  // filter (resolveWebhookSubscribers) is genuinely exercised — not a test-local
  // copy. The positive case proves the pass DOES deliver when subscribed; the
  // negative case proves the SAME pass delivers ZERO when the subscription is
  // lost before delivery, yet still transitions the work item to SENT.
  it("T-events (positive): a still-subscribed active webhook receives the POST via processWebhookDeliveryBatch", async () => {
    await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);

    await parkDeliveryRow(ctx, deliveries[0].id, 3600);
    await unparkDeliveryRow(ctx, deliveries[0].id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    // Non-vacuous positive: the real resolveWebhookSubscribers path found the
    // live subscriber and the delivery core POSTed to the mock server.
    expect(received).toHaveLength(1);
    const afterPos = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(afterPos[0].status).toBe("SENT");
  });

  it("T-events (negative): a webhook that loses subscription (isActive=false) before delivery receives zero POSTs, yet the work item still transitions to SENT", async () => {
    const webhookId = await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);

    // Subscription lost between enqueue and delivery — isActive=false via ctx.su.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_webhooks SET is_active = false WHERE id = $1::uuid`,
        webhookId,
      );
    });

    await parkDeliveryRow(ctx, deliveries[0].id, 3600);
    await unparkDeliveryRow(ctx, deliveries[0].id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    // Zero POSTs via the REAL delivery-time resolveWebhookSubscribers filter —
    // the mutation (not just a status) proves the delivery-time isActive filter.
    expect(received).toHaveLength(0);

    // The work item still transitions to SENT even with zero live subscribers
    // (processOneWebhookDelivery marks SENT unconditionally after the fan-out
    // pass, whether or not any webhook matched).
    const after = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(deliveries[0].id);
    expect(after[0].status).toBe("SENT");
  });

  // ── T-adj (F2 regression, recoverable-not-lost): a v1 (retired)
  // secretAadVersion webhook is subscribed at delivery time. The version gate
  // throws WebhookSecretVersionError — a RECOVERABLE error (pending key
  // migration). processOneWebhookDelivery must collect it via the onError
  // callback and THROW after the pass, so recordWebhookDeliveryError retries the
  // work item (PENDING + attempt_count incremented + next_retry_at in the
  // future) instead of marking it SENT. Marking SENT would permanently LOSE the
  // webhook the moment its secret is migrated. Zero POSTs reach the server.
  //
  // Dropping the onError propagation regresses this to markWebhookDeliverySent —
  // the status assertion (PENDING, not SENT) is the F2 regression guard.
  it("T-adj (F2): a retired secretAadVersion=1 subscriber retries the work item (PENDING) instead of losing it (SENT); zero POSTs", async () => {
    const webhookId = await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
      secretAadVersion: 1,
    });
    // secretAadVersion=1 skips buildWebhookSecretAAD (v1 has no AAD by
    // definition) — encrypt without AAD to keep the fixture internally
    // consistent, even though deliverSingleWebhook never reaches decrypt.
    const masterKey = getMasterKeyByVersion(1);
    const enc = encryptServerData("test-webhook-secret", masterKey);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_webhooks SET secret_encrypted = $1, secret_iv = $2, secret_auth_tag = $3 WHERE id = $4::uuid`,
        enc.ciphertext,
        enc.iv,
        enc.authTag,
        webhookId,
      );
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].attempt_count).toBe(0);

    // Drive the REAL exported delivery primitive (deliverToWebhookRecords is
    // real by default — no override here). park/unpark so the bg worker can't
    // steal it.
    await parkDeliveryRow(ctx, deliveries[0].id, 3600);
    await unparkDeliveryRow(ctx, deliveries[0].id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    // Zero POSTs — the version gate rejected before any fetch.
    expect(received).toHaveLength(0);

    // The work item is RETRIED, not SENT: recordWebhookDeliveryError set PENDING
    // (attempt_count 0→1, below max_attempts) with a future next_retry_at.
    const after = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        { id: string; status: string; attempt_count: number; future_retry: boolean }[]
      >(
        `SELECT id, status, attempt_count, (next_retry_at > now()) AS future_retry
         FROM webhook_deliveries WHERE id = $1::uuid`,
        deliveries[0].id,
      );
    });
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("PENDING");
    expect(after[0].status).not.toBe("SENT");
    expect(after[0].attempt_count).toBe(1);
    expect(after[0].future_retry).toBe(true);
  });

  // ── T-purge (survival-by-id, not count-delta): an aged-SENT outbox row with
  // a PENDING webhook_deliveries row referencing it must survive purgeRetention
  // (NOT EXISTS guard extended to webhook_deliveries); once the delivery is
  // also SENT-and-aged, the outbox row purges.
  it("T-purge: outbox row survives purgeRetention while a PENDING webhook_deliveries row references it; purges once the delivery is SENT and aged", async () => {
    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);

    // Age the outbox row past retention (SENT + old sent_at) while the
    // webhook_deliveries row stays PENDING.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET sent_at = now() - make_interval(hours => $1 + 1) WHERE id = $2::uuid`,
        AUDIT_OUTBOX.RETENTION_HOURS,
        row.id,
      );
    });

    await purgeRetention(ctx.su.prisma, { limit: 1000 });

    const stillThere = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_outbox WHERE id = $1::uuid`,
        row.id,
      );
    });
    expect(stillThere).toHaveLength(1);

    // Now age + SENT the webhook_deliveries row — the NOT EXISTS guard no
    // longer blocks the outbox purge.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE webhook_deliveries SET status = 'SENT', created_at = now() - make_interval(hours => $1 + 1) WHERE id = $2::uuid`,
        AUDIT_OUTBOX.RETENTION_HOURS,
        deliveries[0].id,
      );
    });

    await purgeRetention(ctx.su.prisma, { limit: 1000 });

    const purged = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_outbox WHERE id = $1::uuid`,
        row.id,
      );
    });
    expect(purged).toHaveLength(0);
  });

  // ── Reaper: a stuck PROCESSING webhook_deliveries row is reset to PENDING
  // (or FAILED if attempt_count+1 >= max_attempts) after the processing
  // timeout — driven via the exported reapStuckWebhookDeliveries. The
  // dead-letter-via-infra-throw path is covered separately by T-deadletter.
  it("reaper: a stuck PROCESSING webhook_deliveries row is reset to PENDING after the processing timeout", async () => {
    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);

    const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE webhook_deliveries
         SET status = 'PROCESSING',
             processing_started_at = now() - make_interval(secs => $1 + 30)
         WHERE id = $2::uuid`,
        timeoutSeconds,
        deliveries[0].id,
      );
    });

    await reapStuckWebhookDeliveries(ctx.su.prisma, 1000);

    const after = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(after).toHaveLength(1);
    // attempt_count starts at 0, max_attempts default 8 — well below the
    // dead-letter threshold, so the reaper resets to PENDING (not FAILED).
    expect(after[0].status).toBe("PENDING");
    expect(after[0].attempt_count).toBe(1);
  });

  // ── T-nonchain (GT-3 RETURNING-id fix, plan F-test-4): the NON-chain twin of
  // T-dedup, using the exported deliverRow (NOT deliverRowWithChain) on a
  // chain-disabled tenant. Asserts the {inserted} discriminator true→false
  // explicitly: a dropped `RETURNING id` would make .inserted always false, so
  // the non-chain path would never enqueue — this test would then fail on the
  // first-delivery inserted===true assertion AND the row-count assertion.
  it("T-nonchain: deliverRow returns inserted=true and enqueues once; a reaper re-delivery returns inserted=false and does not add a second webhook_deliveries row", async () => {
    // Chain is disabled by default (see the sanity test) — deliverRow is the
    // production path processBatch takes for this tenant.
    expect(await checkChainEnabled(ctx.su.prisma, tenantId)).toBe(false);

    await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);

    const first = await deliverRow(ctx.su.prisma, row, payload);
    expect(first.inserted).toBe(true);

    const afterFirst = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].status).toBe("PENDING");
    expect(afterFirst[0].scope).toBe("TENANT");

    // Park the row so the bg docker worker (no resolveAndValidateIps mock →
    // would SSRF-block our loopback URL and mark the row SENT without hitting
    // our server) cannot claim it; unpark + claim it ourselves in-process.
    await parkDeliveryRow(ctx, afterFirst[0].id, 3600);
    await unparkDeliveryRow(ctx, afterFirst[0].id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].headers["x-webhook-signature"]).toMatch(/^t=.+,v1=[0-9a-f]{64}$/);
    const afterDeliver = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(afterDeliver).toHaveLength(1);
    expect(afterDeliver[0].status).toBe("SENT");

    // Simulate a reaper re-claim: reset the outbox row to PENDING; the
    // webhook_deliveries row stays (now SENT). deliverRow AGAIN must lose the
    // audit_logs ON CONFLICT (inserted=false) and must NOT re-enqueue.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'PENDING', processing_started_at = NULL WHERE id = $1::uuid`,
        row.id,
      );
    });

    const second = await deliverRow(ctx.su.prisma, row, payload);
    expect(second.inserted).toBe(false);

    const afterSecond = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
  });

  // ── T-deadletter (INV-W4): the WORK-ITEM dead-letter path fires only when the
  // fan-out PASS throws an infra error (not a per-webhook HTTP failure). We
  // induce it by swapping deliverToWebhookRecords for a throwing impl (the same
  // module processWebhookDeliveryBatch imports). Seed a PROCESSING row is not
  // needed — processWebhookDeliveryBatch claims the PENDING row itself; we set
  // attempt_count = max_attempts - 1 so the single failing pass dead-letters.
  it("T-deadletter: a fan-out infra throw at max attempts marks the work item FAILED and emits AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER (unchained, self-scoped)", async () => {
    await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({}, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);
    const maxAttempts = deliveries[0].max_attempts;
    const deliveryId = deliveries[0].id;

    // One more failing pass will dead-letter (newAttemptCount >= max_attempts).
    // Park it in the same statement so the bg worker (its real
    // deliverToWebhookRecords would mark the item SENT on our loopback URL, not
    // FAILED) cannot claim it — only our throwing-mock process delivers it.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE webhook_deliveries
         SET attempt_count = $1, next_retry_at = now() + make_interval(secs => 3600)
         WHERE id = $2::uuid`,
        maxAttempts - 1,
        deliveryId,
      );
    });

    // Force the fan-out pass to throw an infra error (webhooks.length > 0, so
    // processOneWebhookDelivery reaches deliverToWebhookRecords).
    deliverToWebhookRecordsImpl = async () => {
      throw new Error("simulated fan-out infra failure");
    };

    await unparkDeliveryRow(ctx, deliveryId);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    const after = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("FAILED");
    expect(after[0].attempt_count).toBe(maxAttempts);

    // The dead-letter audit event is written directly (unchained, bypass
    // outbox). Self-scoped by tenant_id + action.
    const auditRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM audit_logs
         WHERE tenant_id = $1::uuid AND action = 'AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER'::"AuditAction"`,
        tenantId,
      );
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    // INV-W4: the dead-letter event did NOT re-enter the outbox as a new
    // AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER work item (it is a bypass action).
    const reEnqueued = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM audit_outbox
         WHERE tenant_id = $1::uuid AND payload->>'action' = 'AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER'`,
        tenantId,
      );
    });
    expect(Number(reEnqueued[0].cnt)).toBe(0);
  });

  // ── Sanity: confirm the default tenant state (chain disabled) so a reader
  // knows deliverRowWithChain in the tests above is being called directly
  // (bypassing the processBatch-level chain/non-chain branch), not because
  // the tenant happened to have chain enabled.
  it("sanity: a freshly created tenant has audit_chain_enabled=false by default", async () => {
    const enabled = await checkChainEnabled(ctx.su.prisma, tenantId);
    expect(enabled).toBe(false);
  });

  // ── INV-W1 schema backstop (TENANT / null team_id): the enqueue dedup relies
  // on the `webhook_deliveries_outbox_id_scope_team_id_key` unique index being
  // declared NULLS NOT DISTINCT — otherwise two TENANT-scope rows (team_id NULL)
  // for the same outbox_id would BOTH insert (Postgres treats NULLs as distinct
  // by default), defeating the ON CONFLICT dedup enqueueWebhookDeliveryInTx
  // relies on. T-dedup/T-nonchain short-circuit at the audit_logs gate before a
  // 2nd enqueue is even attempted, so this backstop is otherwise unexercised.
  // Insert twice via the EXACT production SQL and assert only one row survives.
  it("INV-W1 backstop: NULLS NOT DISTINCT dedups two TENANT-scope (null team_id) enqueues for the same outbox_id", async () => {
    const outboxId = randomUUID();

    async function enqueueTenantDelivery(): Promise<void> {
      await ctx.worker.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        // Mirrors enqueueWebhookDeliveryInTx's INSERT exactly (TENANT scope,
        // null team_id, ON CONFLICT (outbox_id, scope, team_id) DO NOTHING).
        await tx.$executeRawUnsafe(
          `INSERT INTO webhook_deliveries (
            id, outbox_id, tenant_id, scope, team_id, action, status, next_retry_at, created_at
          ) VALUES (
            gen_random_uuid(), $1::uuid, $2::uuid, $3::"WebhookDeliveryScope", $4::uuid, $5,
            'PENDING', now(), now()
          )
          ON CONFLICT (outbox_id, scope, team_id) DO NOTHING`,
          outboxId,
          tenantId,
          "TENANT",
          null,
          AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
        );
      });
    }

    await enqueueTenantDelivery();
    await enqueueTenantDelivery();

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM webhook_deliveries WHERE outbox_id = $1::uuid`,
        outboxId,
      );
    });
    // NULLS NOT DISTINCT: the two NULL team_id rows collide → only one survives.
    // Dropping NULLS NOT DISTINCT would let both in and this assertion fails.
    expect(rows).toHaveLength(1);
  });

  // ── F3 (schema backstop): the webhook_deliveries_scope_team_id_ck CHECK
  // constraint enforces the scope/team_id invariant at the storage layer, so an
  // inconsistent enqueue (or an out-of-band write) cannot produce a TEAM row
  // without a team_id or a TENANT row carrying one — which the delivery worker
  // would otherwise use to resolve subscribers. Dropping the CHECK lets both
  // malformed rows insert and this test fails.
  it("F3: CHECK constraint rejects a TEAM row with null team_id and a TENANT row with a non-null team_id", async () => {
    async function tryInsert(scope: string, teamId: string | null): Promise<void> {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO webhook_deliveries (
            id, outbox_id, tenant_id, scope, team_id, action, status, next_retry_at, created_at
          ) VALUES (
            gen_random_uuid(), $1::uuid, $2::uuid, $3::"WebhookDeliveryScope", $4::uuid, $5,
            'PENDING', now(), now()
          )`,
          randomUUID(),
          tenantId,
          scope,
          teamId,
          AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
        );
      });
    }

    // TEAM + null team_id → rejected.
    await expect(tryInsert("TEAM", null)).rejects.toThrow(/scope_team_id_ck|check constraint/i);
    // TENANT + non-null team_id → rejected.
    await expect(tryInsert("TENANT", randomUUID())).rejects.toThrow(/scope_team_id_ck|check constraint/i);

    // Sanity: the two well-formed shapes are accepted (proves the CHECK is not
    // rejecting everything, i.e. the assertion above is non-vacuous).
    await expect(tryInsert("TENANT", null)).resolves.toBeUndefined();
  });

  // ── F3b (TEAM tenant-scoped resolution, positive correctness): a TEAM work
  // item for (tenant, team) is delivered to that team's subscribed webhook via
  // the REAL processWebhookDeliveryBatch → resolveWebhookSubscribers (which now
  // filters by BOTH tenantId AND teamId). Cross-tenant leakage is double-guarded
  // by the F3 CHECK + this filter; a positive test that the (tenantId, teamId)
  // filter delivers to the right team is the correctness anchor.
  it("F3b: a TEAM work item is delivered to the correct team webhook (tenantId+teamId filter)", async () => {
    const teamId = await createTeam(ctx, tenantId);
    await createTeamWebhook(ctx, {
      tenantId,
      teamId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({ scope: AUDIT_SCOPE.TEAM, teamId }, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].scope).toBe("TEAM");
    expect(deliveries[0].team_id).toBe(teamId);

    await parkDeliveryRow(ctx, deliveries[0].id, 3600);
    await unparkDeliveryRow(ctx, deliveries[0].id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    // The team webhook (matched by tenantId+teamId) received the POST.
    expect(received).toHaveLength(1);
    expect(received[0].headers["x-webhook-signature"]).toMatch(/^t=.+,v1=[0-9a-f]{64}$/);
    const sentBody = JSON.parse(received[0].body);
    expect(sentBody.teamId).toBe(teamId);

    const after = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(after[0].status).toBe("SENT");
  });

  // ── F5 (TEAM failure audit scope): a TEAM webhook whose delivery FAILS (mock
  // server returns 500 → deliverWithRetry exhausts retries → onFailure, NOT the
  // recoverable onError path) must record WEBHOOK_DELIVERY_FAILED with TEAM scope
  // + teamId, so it surfaces in the team audit view. Reverting F5 records
  // TENANT/null and fails the scope/team_id assertion.
  it("F5: a failed TEAM webhook delivery audits WEBHOOK_DELIVERY_FAILED with scope=TEAM and team_id", async () => {
    // Mock server returns 500 so deliverWithRetry returns false → onFailure
    // (a genuine delivery failure, distinct from the recoverable onError path).
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        received.push({ headers: req.headers, body: "" });
        res.writeHead(500);
        res.end("nope");
      });
    });

    const teamId = await createTeam(ctx, tenantId);
    await createTeamWebhook(ctx, {
      tenantId,
      teamId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    const payload = makeOutboxPayload({ scope: AUDIT_SCOPE.TEAM, teamId }, userId);
    const row = await enqueueOutboxRow(ctx, tenantId, payload);
    const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
    expect(res.inserted).toBe(true);

    const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
    expect(deliveries).toHaveLength(1);

    await parkDeliveryRow(ctx, deliveries[0].id, 3600);
    await unparkDeliveryRow(ctx, deliveries[0].id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    // The mock server was hit (retries exhausted on 500).
    expect(received.length).toBeGreaterThanOrEqual(1);

    // The failure audit row is TEAM-scoped with the team's id — NOT TENANT/null.
    const auditRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ scope: string; team_id: string | null }[]>(
        `SELECT scope::text AS scope, team_id
         FROM audit_logs
         WHERE tenant_id = $1::uuid
           AND action = 'WEBHOOK_DELIVERY_FAILED'::"AuditAction"`,
        tenantId,
      );
    });
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows.every((r) => r.scope === "TEAM" && r.team_id === teamId)).toBe(true);
  }, 20000);

  // ── F1-runtime (parallelism, not just the math): processWebhookDeliveryBatch
  // now processes claimed work items in PARALLEL chunks of
  // WEBHOOK_DELIVERY_CONCURRENCY (Promise.allSettled), not one-at-a-time. A slow
  // mock server records the MAX simultaneous in-flight requests; with the serial
  // for-loop this would be exactly 1. Enqueue 3 distinct TENANT outbox rows (→ 3
  // separate webhook_deliveries work items), all resolving the same single
  // tenant webhook that POSTs to the slow server, run ONE batch, and assert the
  // observed max in-flight is >= 2 — a serial regression fails this.
  it("F1-runtime: work items are delivered concurrently, not serially", async () => {
    // Slow, in-flight-tracking handler (rewires the beforeEach mock server).
    let inFlight = 0;
    let maxInFlight = 0;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      req.on("data", () => {});
      req.on("end", () => {
        setTimeout(() => {
          received.push({ headers: req.headers, body: "" });
          inFlight--;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 250);
      });
    });

    await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    // Three DISTINCT outbox rows → three separate webhook_deliveries work items
    // (one per outboxId). All resolve the same single tenant webhook.
    const deliveryIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const payload = makeOutboxPayload({}, userId);
      const row = await enqueueOutboxRow(ctx, tenantId, payload);
      const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
      expect(res.inserted).toBe(true);
      const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
      expect(deliveries).toHaveLength(1);
      deliveryIds.push(deliveries[0].id);
    }

    // Park all three far-future so the bg docker worker can't steal any, then
    // unpark all so a single in-process batch claims the whole set at once.
    for (const id of deliveryIds) await parkDeliveryRow(ctx, id, 3600);
    for (const id of deliveryIds) await unparkDeliveryRow(ctx, id);

    const claimed = await processWebhookDeliveryBatch(ctx.worker.prisma, 50);
    expect(claimed).toBe(3);

    // The core assertion: at least 2 requests were in flight simultaneously.
    // WEBHOOK_DELIVERY_CONCURRENCY=4 > 3, so all three overlap; a serial
    // for-loop would cap maxInFlight at 1 and this fails.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(received).toHaveLength(3);

    // All three work items reached SENT.
    const statuses = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM webhook_deliveries WHERE id = ANY($1::uuid[])`,
        deliveryIds,
      );
    });
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => s.status === "SENT")).toBe(true);
  }, 20000);

  // ── R2c (atomic fail_count, no lost update): N work items for the SAME webhook
  // fail concurrently (parallel chunk). onWebhookDeliveryFailure now increments
  // fail_count atomically IN the UPDATE (fail_count = fail_count + 1 RETURNING),
  // so each of the N racing failures counts. The OLD absolute-snapshot write had
  // every concurrent failure read the same failCount and write the same value →
  // lost update, under-count, delayed auto-disable. Assert fail_count == N.
  it("R2c: concurrent failures increment fail_count atomically (no lost update)", async () => {
    // 500-mock so deliverWithRetry exhausts → onFailure fires (same as F5).
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        received.push({ headers: req.headers, body: "" });
        res.writeHead(500);
        res.end("nope");
      });
    });

    const N = 3;
    const webhookId = await createTenantWebhook(ctx, {
      tenantId,
      url: mockUrl(),
      events: [AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE],
    });

    // N DISTINCT outbox rows → N webhook_deliveries work items, all resolving the
    // SAME single webhook. WEBHOOK_DELIVERY_CONCURRENCY (=4) > N, so all N run in
    // one parallel chunk and their fail_count increments race.
    const deliveryIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const payload = makeOutboxPayload({}, userId);
      const row = await enqueueOutboxRow(ctx, tenantId, payload);
      const res = await deliverRowWithChain(ctx.su.prisma, row, payload);
      expect(res.inserted).toBe(true);
      const deliveries = await readWebhookDeliveryRowsByOutboxId(ctx, row.id);
      expect(deliveries).toHaveLength(1);
      deliveryIds.push(deliveries[0].id);
    }

    for (const id of deliveryIds) await parkDeliveryRow(ctx, id, 3600);
    for (const id of deliveryIds) await unparkDeliveryRow(ctx, id);
    await processWebhookDeliveryBatch(ctx.worker.prisma, 50);

    // Every retry-exhausted failure incremented fail_count atomically → exactly N.
    // The old absolute-snapshot write would under-count here (lost update).
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ fail_count: number }[]>(
        `SELECT fail_count FROM tenant_webhooks WHERE id = $1::uuid`,
        webhookId,
      );
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].fail_count).toBe(N);
  }, 30000);
});
