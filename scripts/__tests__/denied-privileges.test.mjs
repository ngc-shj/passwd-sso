/**
 * The prescriptive policy loader's validation, exercised on throwaway files.
 *
 * The two consumers interpolate every field of this file into DDL and act on
 * it — the bootstrap REVOKEs and GRANTs, the audit decides what counts as a
 * finding. A malformed edit that loads is therefore not a cosmetic problem: it
 * is a control that runs against the wrong object, or one whose declaration
 * reads like an enforcement and is inert. Each case below is a shape that
 * would do exactly that.
 *
 * The committed file's CONTENTS are asserted against a live database by
 * `src/__tests__/db-integration/app-role-denied-privileges.integration.test.ts`;
 * this file is about the loader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDeniedPolicy,
  subjectOf,
  isSequenceEntry,
  assertSubjectKind,
} from "../lib/denied-privileges.mjs";

let dir;
let file;

/** Write a policy and load it through the real loader. */
function load(policy) {
  writeFileSync(file, JSON.stringify(policy));
  return loadDeniedPolicy();
}

const TABLE_ENTRY = {
  role: "probe_role",
  table: "public.probe_table",
  privileges: ["SELECT", "INSERT"],
  reason: "test",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "denied-policy-unit-"));
  file = join(dir, "denied.json");
  // `vi.stubEnv`, not a direct assignment — the check-test-hygiene gate forbids
  // `process.env.X =` in test files, and the loader re-reads the variable on
  // every call precisely so an override like this one takes effect.
  vi.stubEnv("DB_DENIED_PRIVILEGES", file);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadDeniedPolicy — subjects", () => {
  it("accepts a table entry and reports its subject", () => {
    const [entry] = load({ denied: [TABLE_ENTRY] });
    expect(subjectOf(entry)).toBe("public.probe_table");
    expect(isSequenceEntry(entry)).toBe(false);
  });

  it("accepts a sequence entry and reports its subject", () => {
    const [entry] = load({
      denied: [
        { role: "probe_role", sequence: "public.probe_seq", privileges: ["USAGE"], reason: "t" },
      ],
    });
    expect(subjectOf(entry)).toBe("public.probe_seq");
    expect(isSequenceEntry(entry)).toBe(true);
  });

  it("rejects an entry naming BOTH a table and a sequence", () => {
    // Ambiguous rather than redundant: the bootstrap would REVOKE against one
    // of the two and the audit would match keys for the other, so the entry
    // would look enforced while covering an object nobody checked.
    expect(() =>
      load({
        denied: [
          {
            role: "probe_role",
            table: "public.probe_table",
            sequence: "public.probe_seq",
            privileges: ["SELECT"],
            reason: "t",
          },
        ],
      }),
    ).toThrow(/exactly one/);
  });

  it("rejects an entry naming NEITHER", () => {
    expect(() =>
      load({ denied: [{ role: "probe_role", privileges: ["SELECT"], reason: "t" }] }),
    ).toThrow(/exactly one/);
  });

  it("rejects a sequence privilege a sequence cannot carry", () => {
    // `GRANT TRUNCATE ON SEQUENCE` does not exist. Accepted here, it would
    // reach the database as a syntax error at bootstrap time — on the run that
    // is supposed to be re-applying security controls.
    expect(() =>
      load({
        denied: [
          { role: "probe_role", sequence: "public.probe_seq", privileges: ["TRUNCATE"], reason: "t" },
        ],
      }),
    ).toThrow(/malformed privilege/);
  });

  it("rejects USAGE on a table entry", () => {
    expect(() => load({ denied: [{ ...TABLE_ENTRY, privileges: ["USAGE"] }] })).toThrow(
      /malformed privilege/,
    );
  });

  it("rejects an unqualified subject", () => {
    // The third silent-inertness axis, after role and subject kind:
    // `to_regclass` resolves it through search_path and the REVOKE succeeds, so
    // the bootstrap enforces — but the audit's keys are always
    // schema-qualified, so the entry matches nothing and reports clean forever.
    expect(() => load({ denied: [{ ...TABLE_ENTRY, table: "probe_table" }] })).toThrow(
      /schema-qualified/,
    );
  });

  it("rejects a repeated (role, subject) pair", () => {
    // Order-dependent and destructive since columnGrants exists: the second
    // entry's table-level REVOKE erases the first entry's column re-grant, and
    // the run that does it is the convergence run meant to restore the control.
    expect(() =>
      load({
        denied: [
          { ...TABLE_ENTRY, columnGrants: { INSERT: ["claim"] } },
          { ...TABLE_ENTRY, privileges: ["INSERT"] },
        ],
      }),
    ).toThrow(/more than once/);
  });

  it("accepts the same subject for a DIFFERENT role", () => {
    // The committed policy does exactly this — one table, three roles — so the
    // duplicate rule must key on the pair, not on the subject alone.
    expect(() =>
      load({
        denied: [TABLE_ENTRY, { ...TABLE_ENTRY, role: "probe_other_role" }],
      }),
    ).not.toThrow();
  });
});

describe("assertSubjectKind", () => {
  const tableEntry = { role: "r", table: "public.t", privileges: ["SELECT"] };
  const sequenceEntry = { role: "r", sequence: "public.s", privileges: ["USAGE"] };

  it.each([["r"], ["p"], ["v"], ["m"]])("accepts relkind %s for a table entry", (relkind) => {
    expect(() => assertSubjectKind(tableEntry, relkind)).not.toThrow();
  });

  it("accepts relkind S for a sequence entry", () => {
    expect(() => assertSubjectKind(sequenceEntry, "S")).not.toThrow();
  });

  it("rejects a table entry whose subject is a sequence", () => {
    // The silent direction. `REVOKE … ON <sequence>` succeeds in the
    // implicit-TABLE form, so the bootstrap looks like it enforced something —
    // while the audit emits SEQUENCE: keys for that object and the entry can
    // never match one.
    expect(() => assertSubjectKind(tableEntry, "S")).toThrow(/DENIED_POLICY_SUBJECT_KIND/);
  });

  it("rejects a sequence entry whose subject is a table", () => {
    // The direction that already failed loudly at the database. Checked here
    // too so the rule is stated once and holds for both consumers, rather than
    // depending on which of them happens to issue the statement first.
    expect(() => assertSubjectKind(sequenceEntry, "r")).toThrow(/DENIED_POLICY_SUBJECT_KIND/);
  });

  it("passes through when the subject does not exist", () => {
    // The pre-migration state. Both other consumers of this declaration treat
    // an absent subject as "not yet created" and skip it; a throw here would
    // make a fresh-database bootstrap fail on its first run.
    expect(() => assertSubjectKind(tableEntry, null)).not.toThrow();
    expect(() => assertSubjectKind(sequenceEntry, undefined)).not.toThrow();
  });
});

describe("loadDeniedPolicy — columnGrants", () => {
  it("accepts a column exception under a denied privilege", () => {
    const [entry] = load({
      denied: [{ ...TABLE_ENTRY, columnGrants: { INSERT: ["claim", "operation"] } }],
    });
    expect(entry.columnGrants.INSERT).toEqual(["claim", "operation"]);
  });

  it("rejects a column exception for a privilege the entry does not deny", () => {
    // The rule that makes the shape mean something. Under a table-level
    // privilege that is still granted, a column list grants nothing and denies
    // nothing — it is a declaration that reads as a control and enforces
    // nothing, which is the failure mode this whole file exists to prevent.
    expect(() =>
      load({
        denied: [
          { ...TABLE_ENTRY, privileges: ["SELECT"], columnGrants: { INSERT: ["claim"] } },
        ],
      }),
    ).toThrow(/does not deny at table level/);
  });

  it("rejects a column exception for a privilege PostgreSQL cannot scope to a column", () => {
    expect(() =>
      load({
        denied: [
          {
            ...TABLE_ENTRY,
            privileges: ["SELECT", "INSERT", "DELETE"],
            columnGrants: { DELETE: ["claim"] },
          },
        ],
      }),
    ).toThrow(/cannot scope to a column/);
  });

  it("rejects an empty column list", () => {
    // "Denied at table level, granted on no column" is spelled by omitting
    // columnGrants entirely. As a written declaration it is a typo that would
    // silently produce `GRANT INSERT () ON …`.
    expect(() => load({ denied: [{ ...TABLE_ENTRY, columnGrants: { INSERT: [] } }] })).toThrow(
      /lists no columns/,
    );
  });

  it("rejects a malformed column name", () => {
    // Committed policy, not input — but every one of these strings is
    // interpolated into DDL, so a malformed edit must stop the run rather than
    // reach the database.
    expect(() =>
      load({ denied: [{ ...TABLE_ENTRY, columnGrants: { INSERT: ["claim; DROP TABLE x"] } }] }),
    ).toThrow(/malformed column/);
  });

  it("rejects a schema-qualified column name", () => {
    expect(() =>
      load({ denied: [{ ...TABLE_ENTRY, columnGrants: { INSERT: ["public.claim"] } }] }),
    ).toThrow(/malformed column/);
  });

  it("rejects a repeated column", () => {
    expect(() =>
      load({ denied: [{ ...TABLE_ENTRY, columnGrants: { INSERT: ["claim", "claim"] } }] }),
    ).toThrow(/repeats a column/);
  });

  it("rejects columnGrants on a sequence entry", () => {
    expect(() =>
      load({
        denied: [
          {
            role: "probe_role",
            sequence: "public.probe_seq",
            privileges: ["USAGE"],
            columnGrants: { INSERT: ["claim"] },
          },
        ],
      }),
    ).toThrow(/only a table entry/);
  });

  it("rejects a non-object columnGrants", () => {
    expect(() => load({ denied: [{ ...TABLE_ENTRY, columnGrants: ["INSERT"] }] })).toThrow(
      /non-object columnGrants/,
    );
  });
});
