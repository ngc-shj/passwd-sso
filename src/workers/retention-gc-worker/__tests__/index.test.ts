/**
 * Boot-validation tests for validateRegistry (C2 / S10 / RT7).
 *
 * validateRegistry accepts an optional registry argument (default: the real
 * RETENTION_REGISTRY) purely for testability, so both branches — accept the
 * real registry, reject a crafted bad entry — are exercised without opening a
 * DB pool. createWorker calls it with no argument before any DB connection.
 */

import { describe, it, expect } from "vitest";
import { validateRegistry } from "../index";
import {
  RETENTION_REGISTRY,
  RLS_FREE_EXPIRY_TABLES,
  type ExpiryEntry,
  type RetentionEntry,
} from "../registry";

describe("validateRegistry — real registry (positive branch)", () => {
  it("does NOT throw on the real RETENTION_REGISTRY", () => {
    expect(() => validateRegistry()).not.toThrow();
  });
});

describe("validateRegistry — RLS-enabled entry missing globalDelete throws (S10/RT7)", () => {
  it("throws when an RLS-enabled table omits globalDelete", () => {
    // sessions is RLS-enabled (not in RLS_FREE_EXPIRY_TABLES) — omitting
    // globalDelete must boot-throw, the exact regression S10 guards against.
    const badEntry: ExpiryEntry = {
      kind: "EXPIRY",
      table: "sessions",
      cutoffColumn: "expires",
      keyColumns: ["id"],
      // globalDelete intentionally omitted
    };
    expect(() => validateRegistry([badEntry])).toThrow(/missing globalDelete/);
  });

  it("does NOT throw when the RLS-free table (verification_tokens) omits globalDelete", () => {
    // The sole RLS-free table legitimately omits the flag — prove the negative
    // test above fails for the right reason (RLS-enabled), not just "no flag".
    const okEntry: ExpiryEntry = {
      kind: "EXPIRY",
      table: "verification_tokens",
      cutoffColumn: "expires",
      keyColumns: ["identifier", "token"],
      // globalDelete omitted — allowed because it is in RLS_FREE_EXPIRY_TABLES
    };
    expect(RLS_FREE_EXPIRY_TABLES.has("verification_tokens")).toBe(true);
    expect(() => validateRegistry([okEntry])).not.toThrow();
  });
});

describe("validateRegistry — bad identifier throws (INV-C2a/INV-C1c)", () => {
  it("throws when a table name contains an unsafe character", () => {
    const badEntry = {
      kind: "EXPIRY",
      table: "sessions; DROP TABLE users",
      cutoffColumn: "expires",
      keyColumns: ["id"],
      globalDelete: true,
    } as unknown as RetentionEntry;
    expect(() => validateRegistry([badEntry])).toThrow(/unsafe identifier/);
  });

  it("throws when a predicate column is unsafe", () => {
    const badEntry = {
      kind: "EXPIRY",
      table: "mcp_clients",
      cutoffColumn: "dcr_expires_at",
      keyColumns: ["id"],
      predicate: [{ column: "is_dcr; --", op: "IS NULL" }],
      globalDelete: true,
    } as unknown as RetentionEntry;
    expect(() => validateRegistry([badEntry])).toThrow(/unsafe identifier/);
  });
});

describe("RETENTION_REGISTRY structural invariants (C1 acceptance)", () => {
  it("has exactly 6 EXPIRY + 1 PER_TENANT_FN entries", () => {
    const expiry = RETENTION_REGISTRY.filter((e) => e.kind === "EXPIRY");
    const perTenant = RETENTION_REGISTRY.filter(
      (e) => e.kind === "PER_TENANT_FN",
    );
    expect(expiry).toHaveLength(6);
    expect(perTenant).toHaveLength(1);
  });

  it("every non-verification_tokens EXPIRY entry has globalDelete:true", () => {
    for (const entry of RETENTION_REGISTRY) {
      if (entry.kind !== "EXPIRY") continue;
      if (entry.table === "verification_tokens") continue;
      expect(entry.globalDelete).toBe(true);
    }
  });

  it("verification_tokens (the only RLS-free table) omits globalDelete", () => {
    const vtEntry = RETENTION_REGISTRY.find(
      (e): e is ExpiryEntry =>
        e.kind === "EXPIRY" && e.table === "verification_tokens",
    );
    expect(vtEntry).toBeDefined();
    expect(vtEntry?.globalDelete).toBeUndefined();
  });
});
