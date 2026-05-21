/**
 * Periodic audit-chain integrity verification worker.
 *
 * Walks every tenant's audit_logs chain hourly and emits:
 *   - CHAIN_VERIFY_HEARTBEAT (success path, every tick) so operators can
 *     detect a silent worker crash via "no heartbeat in 2h" alarm.
 *   - CHAIN_VERIFY_FAILED (on tamper / gap detection) with hysteresis:
 *     re-emit only when the tenant's state transitions clean → failed
 *     OR every 24h while still in failed state.
 *
 * Process lifecycle: long-running (sleep TICK_INTERVAL_MS between rounds).
 * Run as `npm run worker:audit-chain-verify` or `audit-chain-verify-worker`
 * docker-compose service. Uses the standard prisma client (passwd_app role)
 * which retains SELECT on audit_logs after the C13 REVOKE.
 *
 * verifyTenantChain is exported as a pure function for unit testability
 * (T5/T8 cases — pass mocked deps, observe alert/audit emit behavior).
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { resolve } from "node:path";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit/audit-chain";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env") });

const TICK_INTERVAL_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_TICK_INTERVAL_MS ?? 60 * 60 * 1000,
);
const HYSTERESIS_REALERT_MS = Number(
  process.env.AUDIT_CHAIN_VERIFY_REALERT_MS ?? 24 * 60 * 60 * 1000,
);
const MAX_ROWS_PER_TENANT = Number(
  process.env.AUDIT_CHAIN_VERIFY_MAX_ROWS ?? 100_000,
);

export interface VerifyResult {
  tenantId: string;
  ok: boolean;
  totalVerified: number;
  walkedThrough: number;
  firstTamperedSeq: number | null;
}

interface ChainRowRaw {
  id: string;
  tenant_id: string;
  created_at: Date;
  chain_seq: bigint;
  event_hash: Uint8Array;
  chain_prev_hash: Uint8Array | null;
  metadata: unknown;
}

export interface VerifyDeps {
  prisma: PrismaClient;
  logger: { error: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

export async function verifyTenantChain(
  tenantId: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const rows = await deps.prisma.$queryRawUnsafe<ChainRowRaw[]>(
    `SELECT id, tenant_id, created_at,
            chain_seq, event_hash, chain_prev_hash, metadata
     FROM audit_logs
     WHERE tenant_id = $1
       AND chain_seq IS NOT NULL
     ORDER BY chain_seq ASC
     LIMIT $2`,
    tenantId,
    MAX_ROWS_PER_TENANT,
  );

  let prevHash: Buffer = Buffer.from([0x00]);
  let totalVerified = 0;
  let walkedThrough = 0;
  let firstTamperedSeq: number | null = null;

  for (const row of rows) {
    const payload =
      row.metadata != null && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const chainInput = buildChainInput({
      id: row.id,
      createdAt: row.created_at,
      chainSeq: row.chain_seq,
      prevHash,
      payload,
    });
    const computed = computeEventHash(
      prevHash,
      computeCanonicalBytes(chainInput),
    );
    if (!computed.equals(Buffer.from(row.event_hash))) {
      firstTamperedSeq = Number(row.chain_seq);
      break;
    }
    prevHash = Buffer.from(row.event_hash);
    totalVerified++;
    walkedThrough++;
  }

  return {
    tenantId,
    ok: firstTamperedSeq === null,
    totalVerified,
    walkedThrough,
    firstTamperedSeq,
  };
}

// ── Worker main loop ─────────────────────────────────────────────

interface TenantState {
  lastAlertAt: number | null;
  inFailedState: boolean;
}

async function runTick(
  prisma: PrismaClient,
  states: Map<string, TenantState>,
): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  const logger = console;

  for (const { id: tenantId } of tenants) {
    try {
      const result = await verifyTenantChain(tenantId, { prisma, logger });
      const state = states.get(tenantId) ?? {
        lastAlertAt: null,
        inFailedState: false,
      };

      if (!result.ok) {
        const now = Date.now();
        const shouldAlert =
          !state.inFailedState ||
          (state.lastAlertAt !== null &&
            now - state.lastAlertAt >= HYSTERESIS_REALERT_MS);
        if (shouldAlert) {
          logger.error(
            "audit-chain-verify-worker: CHAIN_VERIFY_FAILED tenant=%s firstTamperedSeq=%d walkedThrough=%d",
            tenantId,
            result.firstTamperedSeq,
            result.walkedThrough,
          );
          state.lastAlertAt = now;
        }
        state.inFailedState = true;
      } else {
        state.inFailedState = false;
        state.lastAlertAt = null;
      }
      states.set(tenantId, state);
    } catch (err) {
      logger.error(
        "audit-chain-verify-worker: tenant=%s verify threw: %O",
        tenantId,
        err,
      );
    }
  }

  // Heartbeat: emit a single console log per tick so operators can detect
  // silent worker crashes via "no heartbeat in 2h" alarm.
  console.log(
    JSON.stringify({
      level: "info",
      _logType: "audit-chain-verify-heartbeat",
      tenantCount: tenants.length,
      time: new Date().toISOString(),
    }),
  );
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.AUDIT_CHAIN_VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("AUDIT_CHAIN_VERIFY_DATABASE_URL or DATABASE_URL required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const states = new Map<string, TenantState>();
  const stop = { value: false };
  process.on("SIGTERM", () => { stop.value = true; });
  process.on("SIGINT", () => { stop.value = true; });

  console.log(
    `audit-chain-verify-worker: starting (tick=${TICK_INTERVAL_MS}ms)`,
  );

  while (!stop.value) {
    try {
      await runTick(prisma, states);
    } catch (err) {
      console.error("audit-chain-verify-worker: tick threw:", err);
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }

  await prisma.$disconnect();
  await pool.end();
  console.log("audit-chain-verify-worker: shutdown clean");
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("audit-chain-verify-worker.ts") ||
    process.argv[1].endsWith("audit-chain-verify-worker.js"))
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
