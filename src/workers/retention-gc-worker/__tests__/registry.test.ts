/**
 * INV-C1a/INV-C1b cross-check: every RETENTION_REGISTRY entry resolves against
 * Prisma.dmmf.datamodel.models using the physical-name fallback rule
 * `model.dbName ?? model.name` and `field.dbName ?? field.name`.
 *
 * Critical: sessions.expires and verification_tokens.expires have NO @map, so
 * field.dbName is undefined. The resolver MUST fall back to field.name or the
 * cross-check would silently accept a "skip undefined" variant. T14 provides a
 * positive-presence regression assertion to distinguish a correct fallback from a
 * silent skip.
 */

import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { RETENTION_REGISTRY, type ExpiryEntry } from "../registry";

// Build a lookup: physical table name → { model, physicalFields }
const modelsByPhysicalName = new Map<
  string,
  { fields: Map<string, true> }
>();

for (const model of Prisma.dmmf.datamodel.models) {
  const physicalName = model.dbName ?? model.name;
  const fields = new Map<string, true>();
  for (const field of model.fields) {
    // Scalar and enum fields are both real physical columns; relation fields are
    // not (they are object-graph edges). SC6 provenance projects enum columns
    // (status, share_type, entry_type), so enum fields must be included.
    if (field.kind === "scalar" || field.kind === "enum") {
      const physicalFieldName = (field.dbName as string | undefined) ?? field.name;
      fields.set(physicalFieldName, true);
    }
  }
  modelsByPhysicalName.set(physicalName, { fields });
}

describe("RETENTION_REGISTRY — schema cross-check (INV-C1a)", () => {
  it("contains exactly 6 EXPIRY + 1 EXPIRY_GUARDED + 10 EXPIRY_AUDIT_PROVENANCE + 1 PER_TENANT_FN + 2 PER_TENANT_TRASH + 5 PER_TENANT_AGE entries", () => {
    const expiry = RETENTION_REGISTRY.filter((e) => e.kind === "EXPIRY");
    const guarded = RETENTION_REGISTRY.filter(
      (e) => e.kind === "EXPIRY_GUARDED",
    );
    const provenance = RETENTION_REGISTRY.filter(
      (e) => e.kind === "EXPIRY_AUDIT_PROVENANCE",
    );
    const perTenant = RETENTION_REGISTRY.filter(
      (e) => e.kind === "PER_TENANT_FN",
    );
    const perTenantTrash = RETENTION_REGISTRY.filter(
      (e) => e.kind === "PER_TENANT_TRASH",
    );
    const perTenantAge = RETENTION_REGISTRY.filter(
      (e) => e.kind === "PER_TENANT_AGE",
    );
    expect(expiry).toHaveLength(6);
    expect(guarded).toHaveLength(1);
    expect(provenance).toHaveLength(10);
    expect(perTenant).toHaveLength(1);
    expect(perTenantTrash).toHaveLength(2);
    expect(perTenantAge).toHaveLength(5);
  });

  it("has no duplicate table entries (INV-C1d)", () => {
    const tables = RETENTION_REGISTRY.map((e) => e.table);
    const unique = new Set(tables);
    expect(unique.size).toBe(tables.length);
  });

  for (const entry of RETENTION_REGISTRY) {
    // EXPIRY and EXPIRY_GUARDED both carry table/cutoffColumn/keyColumns.
    if (entry.kind !== "EXPIRY" && entry.kind !== "EXPIRY_GUARDED") continue;

    it(`entry.table "${entry.table}" resolves to a real Prisma model physical name`, () => {
      expect(modelsByPhysicalName.has(entry.table)).toBe(true);
    });

    it(`entry.cutoffColumn "${entry.cutoffColumn}" resolves to a real physical column on "${entry.table}"`, () => {
      const model = modelsByPhysicalName.get(entry.table);
      expect(model).toBeDefined();
      expect(model!.fields.has(entry.cutoffColumn)).toBe(true);
    });

    it(`entry.keyColumns [${entry.keyColumns.join(",")}] all resolve to real physical columns on "${entry.table}"`, () => {
      const model = modelsByPhysicalName.get(entry.table);
      expect(model).toBeDefined();
      for (const col of entry.keyColumns) {
        expect(model!.fields.has(col)).toBe(true);
      }
    });

    // Only EXPIRY entries carry `predicate`; EXPIRY_GUARDED has no predicate field.
    if (entry.kind === "EXPIRY" && entry.predicate && entry.predicate.length > 0) {
      const predicate = entry.predicate;
      it(`entry "${entry.table}" predicate columns resolve to real physical columns`, () => {
        const model = modelsByPhysicalName.get(entry.table);
        expect(model).toBeDefined();
        for (const clause of predicate) {
          expect(model!.fields.has(clause.column)).toBe(true);
        }
      });
    }
  }

  // EXPIRY_AUDIT_PROVENANCE: table + cutoffColumn + every provenanceColumn must
  // resolve to a real physical column (S3/T2). tenant_id must be present.
  for (const entry of RETENTION_REGISTRY) {
    if (entry.kind !== "EXPIRY_AUDIT_PROVENANCE") continue;

    it(`provenance entry "${entry.table}" table + cutoffColumn + provenanceColumns resolve to real physical columns`, () => {
      const model = modelsByPhysicalName.get(entry.table);
      expect(model, `model "${entry.table}" not found`).toBeDefined();
      expect(model!.fields.has(entry.cutoffColumn)).toBe(true);
      for (const col of entry.provenanceColumns) {
        expect(model!.fields.has(col), `column "${col}" missing on "${entry.table}"`).toBe(true);
      }
      expect(entry.provenanceColumns).toContain("tenant_id");
    });
  }

  // PER_TENANT_TRASH: table must resolve and must carry deleted_at (the
  // soft-delete tombstone the sweeper filters on) + tenant_id (per-tenant scope).
  for (const entry of RETENTION_REGISTRY) {
    if (entry.kind !== "PER_TENANT_TRASH") continue;

    it(`trash entry "${entry.table}" resolves and carries deleted_at + tenant_id`, () => {
      const model = modelsByPhysicalName.get(entry.table);
      expect(model, `model "${entry.table}" not found`).toBeDefined();
      expect(model!.fields.has("deleted_at")).toBe(true);
      expect(model!.fields.has("tenant_id")).toBe(true);
    });
  }

  // PER_TENANT_AGE: table must resolve and carry the cutoffColumn + tenant_id.
  for (const entry of RETENTION_REGISTRY) {
    if (entry.kind !== "PER_TENANT_AGE") continue;

    it(`age entry "${entry.table}" resolves and carries cutoffColumn "${entry.cutoffColumn}" + tenant_id`, () => {
      const model = modelsByPhysicalName.get(entry.table);
      expect(model, `model "${entry.table}" not found`).toBeDefined();
      expect(
        model!.fields.has(entry.cutoffColumn),
        `cutoffColumn "${entry.cutoffColumn}" missing on "${entry.table}"`,
      ).toBe(true);
      expect(model!.fields.has("tenant_id")).toBe(true);
    });
  }
});

// T14: positive-presence regression assertion for sessions.expires and
// verification_tokens.expires — these fields have NO @map so field.dbName is
// undefined, meaning the resolver MUST fall back to field.name. A "skip undefined"
// variant would also not throw; only a positive presence check distinguishes them.
describe("RETENTION_REGISTRY — T14 positive presence regression (dbName ?? name fallback)", () => {
  it("sessions model physical columns include 'expires' via field.name fallback (not merely no-throw)", () => {
    const model = modelsByPhysicalName.get("sessions");
    expect(model).toBeDefined();
    expect(model!.fields.has("expires")).toBe(true);
  });

  it("verification_tokens model physical columns include 'expires' via field.name fallback", () => {
    const model = modelsByPhysicalName.get("verification_tokens");
    expect(model).toBeDefined();
    expect(model!.fields.has("expires")).toBe(true);
  });

  it("verification_tokens model physical columns include 'identifier' and 'token' via field.name fallback", () => {
    const model = modelsByPhysicalName.get("verification_tokens");
    expect(model).toBeDefined();
    expect(model!.fields.has("identifier")).toBe(true);
    expect(model!.fields.has("token")).toBe(true);
  });
});

// INV-C1b: keyColumns must form a valid row identity.
// For id-keyed tables, "id" is a scalar field on the model.
// For verification_tokens, ["identifier","token"] matches the composite @@id.
// We assert that for each EXPIRY entry, each keyColumn is a scalar field
// on the model (structural check: they are the declared identity columns).
describe("RETENTION_REGISTRY — keyColumns row identity check (INV-C1b)", () => {
  const expiryEntries = RETENTION_REGISTRY.filter(
    (e): e is ExpiryEntry => e.kind === "EXPIRY",
  );

  for (const entry of expiryEntries) {
    it(`"${entry.table}" keyColumns are present as scalar fields (identity check)`, () => {
      const model = modelsByPhysicalName.get(entry.table);
      expect(model).toBeDefined();
      for (const col of entry.keyColumns) {
        expect(model!.fields.has(col)).toBe(true);
      }
    });
  }

  it("verification_tokens uses composite keyColumns [identifier, token] (not a bare id column)", () => {
    const vtEntry = RETENTION_REGISTRY.find(
      (e) => e.kind === "EXPIRY" && e.table === "verification_tokens",
    ) as ExpiryEntry | undefined;
    expect(vtEntry).toBeDefined();
    expect(vtEntry!.keyColumns).toEqual(["identifier", "token"]);
  });
});
