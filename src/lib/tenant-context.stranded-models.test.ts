/**
 * The member set `countStrandedRows` reports is DERIVED from the schema, not
 * listed in a docstring.
 *
 * Round 4 found the first version counting `passwordEntry` / `tag` / `folder`
 * and nothing else, so `{0,0,0}` read as "nothing stranded" for a user whose
 * passkeys, tokens and sessions were all still filed under the tenant that
 * released them. The remedy is not a longer hand-list — that is the same defect
 * one iteration later — but this test: every model declaring `tenantId` beside a
 * user column must be either counted or explicitly excluded WITH A REASON, so a
 * model added to the schema later fails here instead of reporting a silent zero.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STRANDED_COUNTERS } from "./tenant-context";

/** Columns that mean "the user this row belongs to". */
const USER_COLUMNS = ["userId", "createdById", "ownerId"] as const;

/**
 * Models the realignment does NOT strand, each with the reason it is out.
 *
 * A reason is mandatory: the exclusion is the deliberate act, and it is what the
 * next reviewer reads instead of re-deriving the judgement.
 */
const NOT_STRANDED: Record<string, string> = {
  AuditLog:
    "the trail itself, moved by audit_log_tenant_migrate rather than owned by the user",
  TenantMember: "the membership, not data filed under one",
  TeamMember: "a membership in a team, same reason",
  TeamPasswordEntry: "team-owned; createdById is provenance, not ownership",
  ScimToken: "tenant-owned credential; createdById is who minted it",
  ServiceAccount: "tenant-owned identity; createdById is who created it",
  McpClient: "tenant-owned OAuth client; createdById is who registered it",
};

/** model -> its declared fields, from the schema the gate and the app share. */
function parseSchema(): Map<string, Map<string, string>> {
  const src = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const models = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of src.split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = new Map();
      models.set(open[1], current);
      continue;
    }
    if (/^\}/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("@@") || trimmed.startsWith("//")) continue;
    const field = /^[ \t]+(\w+)[ \t]+([A-Za-z_]\w*)/.exec(line);
    if (field) current.set(field[1], field[2]);
  }
  return models;
}

/** `TenantMember` -> `tenantMember`, the Prisma client handle. */
const handleOf = (model: string) => model[0].toLowerCase() + model.slice(1);

describe("countStrandedRows member set", () => {
  const models = parseSchema();

  it("parsed a schema with models in it", () => {
    // "Examined nothing" must not be spelled like "found nothing": a parse that
    // silently returned an empty map would make every assertion below vacuous.
    expect(models.size).toBeGreaterThan(20);
    expect(models.has("User")).toBe(true);
  });

  it("counts or excludes every tenant-scoped model a user owns", () => {
    const derived = [...models]
      .filter(([, f]) => f.has("tenantId") && USER_COLUMNS.some((c) => f.has(c)))
      .map(([model]) => model);
    expect(derived.length).toBeGreaterThan(0);

    const counted = new Set(Object.keys(STRANDED_COUNTERS));
    const unaccounted = derived.filter(
      (model) => !counted.has(handleOf(model)) && !(model in NOT_STRANDED),
    );
    expect(
      unaccounted,
      "a model declaring tenantId beside a user column must be counted by " +
        "STRANDED_COUNTERS or named in NOT_STRANDED with a reason — otherwise a " +
        "realignment reports zero for rows it stranded",
    ).toEqual([]);
  });

  it("counts nothing the schema does not put in the class", () => {
    // The reverse direction. A counter for a model that is not tenant-scoped, or
    // that the user does not own, counts rows no realignment can strand — and
    // reads to the operator as evidence about a table it is not about.
    const derivedHandles = new Set(
      [...models]
        .filter(([, f]) => f.has("tenantId") && USER_COLUMNS.some((c) => f.has(c)))
        .map(([model]) => handleOf(model)),
    );
    const strays = Object.keys(STRANDED_COUNTERS).filter((h) => !derivedHandles.has(h));
    expect(strays).toEqual([]);
  });

  it("excludes nothing that is not in the class, and gives every exclusion a reason", () => {
    const derived = new Set(
      [...models]
        .filter(([, f]) => f.has("tenantId") && USER_COLUMNS.some((c) => f.has(c)))
        .map(([model]) => model),
    );
    for (const [model, reason] of Object.entries(NOT_STRANDED)) {
      expect(derived.has(model), `${model} is excluded but not in the class`).toBe(true);
      expect(reason.length, `${model} is excluded with no reason`).toBeGreaterThan(10);
    }
  });
});
