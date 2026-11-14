import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import {
  HARNESS_ROLES,
  analyzeGrantEvidence,
  compareGrantEvidence,
  main,
  parseBaseline,
  parseEvidenceFile,
} from "../checks/check-rls-grant-evidence";

const GRANTS = {
  A: { purpose: "p1", tables: "a,b" },
  // Shares A's pair: members with one (purpose, tables) share their evidence.
  B: { purpose: "p1", tables: "a,b" },
  C: { purpose: "p2", tables: "c" },
};

const role = (name: string, rolsuper = false, rolbypassrls = false) => ({ kind: "role", name, rolsuper, rolbypassrls });
const grant = (purpose: string, tables: string, roleName: string) => ({ kind: "grant", purpose, tables, role: roleName });
const harnessRoles = HARNESS_ROLES.map((r) => role(r));
const superuserRole = role("migration_owner", true, true);

describe("compareGrantEvidence", () => {
  it("passes when every member has restricted-role evidence and the baseline is empty", () => {
    const { failures, tally } = compareGrantEvidence({
      lines: [...harnessRoles, grant("p1", "a,b", "passwd_app"), grant("p2", "c", "passwd_app")],
      grants: GRANTS,
      baseline: [],
    });
    expect(failures).toEqual([]);
    expect(tally).toMatchObject({ members: 3, exercised: 3, unexercised: [] });
  });

  it("gives members sharing a (purpose, tables) pair the same evidence", () => {
    const { tally } = analyzeGrantEvidence({
      lines: [...harnessRoles, grant("p1", "a,b", "passwd_app")],
      grants: GRANTS,
    });
    expect(tally.unexercised).toEqual(["C"]);
  });

  it("matches a table list in another order", () => {
    const { tally } = analyzeGrantEvidence({
      lines: [...harnessRoles, grant("p1", "b,a", "passwd_app"), grant("p2", "c", "passwd_app")],
      grants: GRANTS,
    });
    expect(tally.unexercised).toEqual([]);
  });

  it("does not match a pair whose purpose or tables differ", () => {
    const { tally } = analyzeGrantEvidence({
      lines: [...harnessRoles, grant("p2", "a,b", "passwd_app"), grant("p1", "a", "passwd_app")],
      grants: GRANTS,
    });
    expect(tally.unexercised).toEqual(["A", "B", "C"]);
  });

  it("counts no evidence from a SUPERUSER or BYPASSRLS role", () => {
    const { tally } = analyzeGrantEvidence({
      lines: [
        ...harnessRoles,
        superuserRole,
        role("bypass_login", false, true),
        grant("p1", "a,b", "migration_owner"),
        grant("p2", "c", "bypass_login"),
      ],
      grants: GRANTS,
    });
    expect(tally.unexercised).toEqual(["A", "B", "C"]);
  });

  it("tallies a grant line whose role has no attribute line as no evidence, not a failure", () => {
    const { failures, tally } = compareGrantEvidence({
      lines: [...harnessRoles, grant("p1", "a,b", "passwd_app"), grant("p2", "c", "cell_made_login")],
      grants: GRANTS,
      baseline: ["C"],
    });
    expect(failures).toEqual([]);
    expect(tally).toMatchObject({ unknownRoleLines: 1, unknownRoles: ["cell_made_login"], unexercised: ["C"] });
  });

  it("fails when a harness role has no attribute line", () => {
    const { failures } = compareGrantEvidence({
      lines: [...harnessRoles.filter((l) => l.name !== "passwd_anchor_publisher"), grant("p1", "a,b", "passwd_app"), grant("p2", "c", "passwd_app")],
      grants: GRANTS,
      baseline: [],
    });
    expect(failures).toEqual([expect.stringContaining("passwd_anchor_publisher")]);
  });

  it("fails when no grant line resolves to a NOSUPERUSER NOBYPASSRLS role", () => {
    const { failures } = compareGrantEvidence({
      lines: [...harnessRoles, superuserRole, grant("p1", "a,b", "migration_owner")],
      grants: GRANTS,
      baseline: ["A", "B", "C"],
    });
    expect(failures).toEqual([expect.stringContaining("no grant line resolves to a NOSUPERUSER NOBYPASSRLS role")]);
  });

  describe("the baseline, in both directions", () => {
    const lines = [...harnessRoles, grant("p1", "a,b", "passwd_app")];

    it("fails when a member is unexercised and not listed", () => {
      const { failures } = compareGrantEvidence({ lines, grants: GRANTS, baseline: [] });
      expect(failures).toEqual([expect.stringMatching(/^C has no .*evidence and is not in the baseline/)]);
    });

    it("passes when the unexercised member is listed", () => {
      expect(compareGrantEvidence({ lines, grants: GRANTS, baseline: ["C"] }).failures).toEqual([]);
    });

    it("fails when a listed member now has evidence", () => {
      const { failures } = compareGrantEvidence({ lines, grants: GRANTS, baseline: ["C", "A"] });
      expect(failures).toEqual(["A is in the baseline but now has evidence: remove it"]);
    });

    it("fails when a listed name is not a BYPASS_GRANT member", () => {
      const { failures } = compareGrantEvidence({ lines, grants: GRANTS, baseline: ["C", "GONE"] });
      expect(failures).toEqual(["GONE is in the baseline but is not a BYPASS_GRANT member"]);
    });
  });
});

describe("parseBaseline", () => {
  it("reads one name per line and skips comments and blank lines", () => {
    expect(parseBaseline("# why\n\nA\n  B  \n# C\n")).toEqual(["A", "B"]);
  });
});

describe("parseEvidenceFile", () => {
  it("reports a line that is not JSON", () => {
    const parsed = parseEvidenceFile('{"kind":"role"}\nnot json\n\n');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.errors).toEqual(["evidence line 2 is not JSON"]);
  });
});

describe("main", () => {
  let dir: string;
  let spies: Array<{ mockRestore: () => void }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rls-grant-evidence-"));
    spies = [vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, lines: unknown[]) => {
    const file = join(dir, name);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : ""));
    return file;
  };
  const everyMember = Object.values(BYPASS_GRANT).map((g) => grant(g.purpose, g.tables, "passwd_app"));

  it("exits 1 when the evidence file is absent", () => {
    expect(main([join(dir, "missing.jsonl"), "--baseline", join(dir, "b.txt")])).toBe(1);
  });

  it("exits 1 when the evidence file is empty", () => {
    const file = join(dir, "empty.jsonl");
    writeFileSync(file, "");
    expect(main([file, "--baseline", join(dir, "b.txt")])).toBe(1);
  });

  it("exits 0 when every member has evidence and the baseline is empty", () => {
    const file = write("all.jsonl", [...harnessRoles, ...everyMember]);
    const baseline = join(dir, "b.txt");
    writeFileSync(baseline, "# none\n");
    expect(main([file, "--baseline", baseline])).toBe(0);
  });

  it("exits 1 for a member missing from both the evidence and the baseline", () => {
    const [, ...rest] = Object.values(BYPASS_GRANT);
    const file = write("one-short.jsonl", [...harnessRoles, ...rest.map((g) => grant(g.purpose, g.tables, "passwd_app"))]);
    const baseline = join(dir, "b.txt");
    writeFileSync(baseline, "");
    expect(main([file, "--baseline", baseline])).toBe(1);
  });

  it("--write lists the unexercised members, and the check then passes against it", () => {
    const [first, ...rest] = Object.entries(BYPASS_GRANT);
    const file = write("w.jsonl", [...harnessRoles, ...rest.map(([, g]) => grant(g.purpose, g.tables, "passwd_app"))]);
    const baseline = join(dir, "b.txt");
    expect(main([file, "--write", "--baseline", baseline])).toBe(0);
    expect(parseBaseline(readFileSync(baseline, "utf8"))).toEqual([first[0]]);
    expect(main([file, "--baseline", baseline])).toBe(0);
  });

  it("--write refuses when a harness role has no attribute line, leaving the baseline unwritten", () => {
    const file = write("w2.jsonl", [...harnessRoles.slice(1), ...everyMember]);
    const baseline = join(dir, "b.txt");
    expect(main([file, "--write", "--baseline", baseline])).toBe(1);
    expect(() => readFileSync(baseline)).toThrow();
  });

  it("--write refuses an absent file", () => {
    expect(main([join(dir, "missing.jsonl"), "--write", "--baseline", join(dir, "b.txt")])).toBe(1);
  });
});
