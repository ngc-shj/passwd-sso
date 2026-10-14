/**
 * Per-member deny/allow for the RLS bypass assert (#874, C2 / T2).
 *
 * Each sweep that takes a tx asserts the bypass state its entry declares
 * before it touches a row. The tx here is a strict recorder: a Proxy over
 * every `$` method and every model, so a write by ANY path (raw SQL, a model
 * call, a set_config) is recorded. On a deny the only recorded call must be
 * the single `current_setting` read; on the paired allow the member goes on
 * to its write.
 */

import { describe, it, expect } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  sweepExpiryEntry,
  sweepGuardedExpiryEntry,
  sweepAuditProvenanceEntry,
  sweepAuditLogs,
  sweepPerTenantAge,
  sweepExpiredAccessRequests,
} from "../sweep";
import {
  RETENTION_REGISTRY,
  type RetentionEntry,
  type ExpiryEntry,
  type GuardedExpiryEntry,
  type AuditProvenanceEntry,
  type PerTenantFnEntry,
  type PerTenantAgeEntry,
} from "../registry";
import { isAssertRead, sqlText } from "@/__tests__/workers/retention-gc-tx-fakes";

const C2_ERROR = "retention-gc sweep requires the RLS bypass state its entry declares";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

interface RecordedCall {
  name: string;
  args: unknown[];
}

type ReadAnswer = { rows: unknown[] } | { error: Error };

/** A tx that records every call; the bypass read answers with `read`. */
function makeRecordingTx(read: ReadAnswer) {
  const calls: RecordedCall[] = [];

  const answer = (name: string, args: unknown[]): unknown => {
    if (name === "$queryRaw" && isAssertRead(sqlText(args[0]))) {
      if ("error" in read) throw read.error;
      return read.rows;
    }
    if (name === "$executeRaw" || name === "$executeRawUnsafe") return 0;
    // One tenant with every retention column set, so the per-tenant members
    // reach their write on an allow.
    if (name === "tenant.findMany") {
      return [{ id: TENANT_ID, auditLogRetentionDays: 90, historyRetentionDays: 90 }];
    }
    return [];
  };

  const record =
    (name: string) =>
    (...args: unknown[]): Promise<unknown> => {
      calls.push({ name, args });
      try {
        return Promise.resolve(answer(name, args));
      } catch (err) {
        return Promise.reject(err);
      }
    };

  const model = (modelName: string) =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === "symbol" ? undefined : record(`${modelName}.${prop}`),
      },
    );

  const tx = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        return prop.startsWith("$") ? record(prop) : model(prop);
      },
    },
  ) as Prisma.TransactionClient;

  return { tx, calls };
}

function registryEntry<K extends RetentionEntry["kind"], T extends RetentionEntry & { kind: K }>(
  kind: K,
  table: string,
): T {
  const entry = RETENTION_REGISTRY.find((e) => e.kind === kind && e.table === table);
  if (!entry) throw new Error(`registry has no ${kind} entry for ${table}`);
  return entry as T;
}

const SESSIONS = registryEntry<"EXPIRY", ExpiryEntry>("EXPIRY", "sessions");
const VERIFICATION_TOKENS = registryEntry<"EXPIRY", ExpiryEntry>("EXPIRY", "verification_tokens");
const MCP_ACCESS_TOKENS = registryEntry<"EXPIRY_GUARDED", GuardedExpiryEntry>(
  "EXPIRY_GUARDED",
  "mcp_access_tokens",
);
const API_KEYS = registryEntry<"EXPIRY_AUDIT_PROVENANCE", AuditProvenanceEntry>(
  "EXPIRY_AUDIT_PROVENANCE",
  "api_keys",
);
const AUDIT_LOGS = registryEntry<"PER_TENANT_FN", PerTenantFnEntry>("PER_TENANT_FN", "audit_logs");
const HISTORIES: PerTenantAgeEntry = {
  kind: "PER_TENANT_AGE",
  table: "password_entry_histories",
  cutoffColumn: "changed_at",
  tenantRetentionColumn: "historyRetentionDays",
  auditAction: "HISTORY_RETENTION_PURGED",
};

interface MemberCase {
  name: string;
  /** True for the entry-gated kinds, whose expected state follows globalDelete. */
  gated: boolean;
  /** The call that marks the member reaching its write. */
  write: string;
  run: (tx: Prisma.TransactionClient, globalDelete: boolean) => Promise<number>;
}

const MEMBERS: MemberCase[] = [
  {
    name: "sweepExpiryEntry",
    gated: true,
    write: "$executeRawUnsafe",
    run: (tx, globalDelete) =>
      sweepExpiryEntry(tx, globalDelete ? SESSIONS : VERIFICATION_TOKENS, 100),
  },
  {
    name: "sweepGuardedExpiryEntry",
    gated: true,
    write: "$executeRawUnsafe",
    run: (tx, globalDelete) =>
      sweepGuardedExpiryEntry(
        tx,
        globalDelete ? MCP_ACCESS_TOKENS : { ...MCP_ACCESS_TOKENS, globalDelete: undefined },
        100,
      ),
  },
  {
    name: "sweepAuditProvenanceEntry",
    gated: true,
    write: "$queryRawUnsafe",
    run: (tx, globalDelete) =>
      sweepAuditProvenanceEntry(
        tx,
        globalDelete ? API_KEYS : { ...API_KEYS, globalDelete: undefined },
        100,
      ),
  },
  {
    name: "sweepAuditLogs",
    gated: false,
    write: "$queryRaw",
    run: (tx) => sweepAuditLogs(tx, AUDIT_LOGS),
  },
  {
    name: "sweepPerTenantAge",
    gated: false,
    write: "$executeRawUnsafe",
    run: (tx) => sweepPerTenantAge(tx, HISTORIES, 100),
  },
  {
    name: "sweepExpiredAccessRequests",
    gated: false,
    write: "$executeRawUnsafe",
    run: (tx) => sweepExpiredAccessRequests(tx, 100),
  },
];

// Reads that deny when the entry declares the bypass (expected = true).
const DENY_WHEN_EXPECTED: ReadonlyArray<readonly [string, unknown[]]> = [
  ["null", [{ bypass_rls: null }]],
  ["'off'", [{ bypass_rls: "off" }]],
  ["'' (a pooled connection after an earlier tx-local set)", [{ bypass_rls: "" }]],
  ["no row", []],
];

// Reads that deny when the entry does not declare it (expected = false).
const DENY_WHEN_NOT_EXPECTED: ReadonlyArray<readonly [string, unknown[]]> = [
  ["'on' (a caller's bypass)", [{ bypass_rls: "on" }]],
  ["no row", []],
];

const ALLOW_WHEN_NOT_EXPECTED: ReadonlyArray<readonly [string, unknown[]]> = [
  ["null", [{ bypass_rls: null }]],
  ["'off'", [{ bypass_rls: "off" }]],
  ["''", [{ bypass_rls: "" }]],
];

function expectOnlyTheRead(calls: RecordedCall[]) {
  expect(calls.map((c) => c.name)).toEqual(["$queryRaw"]);
  expect(isAssertRead(sqlText(calls[0].args[0]))).toBe(true);
}

function expectReachedWrite(calls: RecordedCall[], write: string) {
  expect(calls[0].name).toBe("$queryRaw");
  expect(isAssertRead(sqlText(calls[0].args[0]))).toBe(true);
  expect(calls.slice(1).map((c) => c.name)).toContain(write);
}

describe.each(MEMBERS)("$name asserts the bypass its entry declares (C2)", (member) => {
  // For a gated member the "declared" entry is the globalDelete one; the
  // ungated members always declare the bypass.
  describe("entry declares the bypass", () => {
    it.each(DENY_WHEN_EXPECTED)("denies a %s read before touching a row", async (_label, rows) => {
      const { tx, calls } = makeRecordingTx({ rows });
      await expect(member.run(tx, true)).rejects.toThrow(C2_ERROR);
      expectOnlyTheRead(calls);
    });

    it("propagates a failed read before touching a row", async () => {
      const readError = new Error("read failed");
      const { tx, calls } = makeRecordingTx({ error: readError });
      await expect(member.run(tx, true)).rejects.toBe(readError);
      expectOnlyTheRead(calls);
    });

    it("allows an 'on' read and reaches its write", async () => {
      const { tx, calls } = makeRecordingTx({ rows: [{ bypass_rls: "on" }] });
      await expect(member.run(tx, true)).resolves.toBe(0);
      expectReachedWrite(calls, member.write);
    });
  });
});

describe.each(MEMBERS.filter((m) => m.gated))(
  "$name with an entry that does not declare globalDelete (C2, S2)",
  (member) => {
    it.each(DENY_WHEN_NOT_EXPECTED)("denies a %s read before touching a row", async (_label, rows) => {
      const { tx, calls } = makeRecordingTx({ rows });
      await expect(member.run(tx, false)).rejects.toThrow(C2_ERROR);
      expectOnlyTheRead(calls);
    });

    it("propagates a failed read before touching a row", async () => {
      const readError = new Error("read failed");
      const { tx, calls } = makeRecordingTx({ error: readError });
      await expect(member.run(tx, false)).rejects.toBe(readError);
      expectOnlyTheRead(calls);
    });

    it.each(ALLOW_WHEN_NOT_EXPECTED)("allows a %s read and reaches its write", async (_label, rows) => {
      const { tx, calls } = makeRecordingTx({ rows });
      await expect(member.run(tx, false)).resolves.toBe(0);
      expectReachedWrite(calls, member.write);
    });
  },
);
