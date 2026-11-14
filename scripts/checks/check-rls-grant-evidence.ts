/**
 * Per-grant evidence gate (C11). The integration suite runs with
 * RLS_GRANT_EVIDENCE_FILE set; its harness appends one line per bypass grant a
 * connection set (src/__tests__/db-integration/rls-grant-evidence-recorder.ts)
 * and one per role whose attributes it read. This check reads only that file.
 *
 * A BYPASS_GRANT member has evidence when a connection logged in as a role that
 * is NOSUPERUSER, NOBYPASSRLS and cannot come to run as another role (no
 * CREATEROLE, no membership with SET or ADMIN: `canSetRole` false on its
 * attribute line) set its (purpose, tables) in a suite run that
 * passed — where any report or refusal fails a test. That rests on one
 * PostgreSQL fact: a session whose login role has none of those cannot change
 * `current_user`, so the login user is the role every statement ran as. Two
 * things it does not cover: a SECURITY DEFINER routine, which runs as its owner
 * by design (not seen here), and a role that inherits the table owner (the
 * probe role of rds-probe-role.ts) issuing owner DDL that turns row-level
 * security off for itself, which the cells using it do not do. The recorder files a connection whose startup options set a
 * role under a name no attribute line carries, and an attribute line without
 * `canSetRole` (written before the field existed) does not count as restricted:
 * both fail toward no evidence. The check does not show
 * that a production call site set the grant, or that every table of it was
 * examined. The members without evidence are committed in
 * rls-grant-evidence-baseline.txt: a lower bound on what rests on production
 * observation.
 *
 * Usage:
 *   tsx scripts/checks/check-rls-grant-evidence.ts [<evidence file>] [--baseline <path>]
 *   tsx scripts/checks/check-rls-grant-evidence.ts [<evidence file>] --write
 * The file defaults to $RLS_GRANT_EVIDENCE_FILE. Exit 1 on any failure.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";

/** Roles setup.ts describes whatever the local configuration: the fixed ones the suite connects as. */
export const HARNESS_ROLES = [
  "passwd_app",
  "passwd_outbox_worker",
  "passwd_retention_gc_worker",
  "passwd_anchor_publisher",
  "passwd_audit_chain_verifier",
] as const;

export const BASELINE_PATH = fileURLToPath(new URL("./rls-grant-evidence-baseline.txt", import.meta.url));

type GrantShape = { purpose: string; tables: string };
type RoleAttrs = { rolsuper: boolean; rolbypassrls: boolean; canSetRole: boolean | undefined };

export type EvidenceTally = {
  grantLines: number;
  roleLines: number;
  /** Grant lines whose role has no attribute line: no evidence, not a failure. */
  unknownRoleLines: number;
  unknownRoles: string[];
  ignoredLines: number;
  members: number;
  exercised: number;
  unexercised: string[];
};

export type EvidenceAnalysis = { problems: string[]; tally: EvidenceTally };

function normalizeTables(tables: string): string {
  return tables.split(",").map((t) => t.trim()).sort().join(",");
}

const pairKey = (purpose: string, tables: string) => `${purpose}|${normalizeTables(tables)}`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The shared part of check and `--write`: what the file shows, and what is
 * wrong with the file itself (as opposed to the baseline).
 */
export function analyzeGrantEvidence({
  lines,
  grants,
}: {
  lines: readonly unknown[];
  grants: Readonly<Record<string, GrantShape>>;
}): EvidenceAnalysis {
  const roles = new Map<string, RoleAttrs>();
  const grantLines: { purpose: string; tables: string; role: string }[] = [];
  let ignoredLines = 0;
  for (const line of lines) {
    if (isObject(line) && line.kind === "role" && typeof line.name === "string" &&
        typeof line.rolsuper === "boolean" && typeof line.rolbypassrls === "boolean") {
      roles.set(line.name, {
        rolsuper: line.rolsuper,
        rolbypassrls: line.rolbypassrls,
        canSetRole: typeof line.canSetRole === "boolean" ? line.canSetRole : undefined,
      });
    } else if (isObject(line) && line.kind === "grant" && typeof line.purpose === "string" &&
               typeof line.tables === "string" && typeof line.role === "string") {
      grantLines.push({ purpose: line.purpose, tables: line.tables, role: line.role });
    } else {
      ignoredLines += 1;
    }
  }

  const problems: string[] = [];
  for (const role of HARNESS_ROLES) {
    if (!roles.has(role)) problems.push(`no attribute line for harness role ${role}: setup.ts did not describe it`);
  }

  const evidenced = new Set<string>();
  const unknownRoles = new Set<string>();
  let unknownRoleLines = 0;
  let restrictedLines = 0;
  for (const line of grantLines) {
    const attrs = roles.get(line.role);
    if (!attrs) {
      unknownRoleLines += 1;
      unknownRoles.add(line.role);
    } else if (!attrs.rolsuper && !attrs.rolbypassrls && attrs.canSetRole === false) {
      restrictedLines += 1;
      evidenced.add(pairKey(line.purpose, line.tables));
    }
  }
  if (restrictedLines === 0) {
    problems.push("no grant line resolves to a NOSUPERUSER NOBYPASSRLS role that cannot SET ROLE: the record shows nothing about enforcement");
  }

  const names = Object.keys(grants).sort();
  const unexercised = names.filter((n) => !evidenced.has(pairKey(grants[n].purpose, grants[n].tables)));
  return {
    problems,
    tally: {
      grantLines: grantLines.length,
      roleLines: roles.size,
      unknownRoleLines,
      unknownRoles: [...unknownRoles].sort(),
      ignoredLines,
      members: names.length,
      exercised: names.length - unexercised.length,
      unexercised,
    },
  };
}

export function compareGrantEvidence({
  lines,
  grants,
  baseline,
}: {
  lines: readonly unknown[];
  grants: Readonly<Record<string, GrantShape>>;
  baseline: readonly string[];
}): { failures: string[]; tally: EvidenceTally } {
  const { problems, tally } = analyzeGrantEvidence({ lines, grants });
  const failures = [...problems];
  const listed = new Set(baseline);
  const unexercised = new Set(tally.unexercised);
  for (const name of tally.unexercised) {
    if (!listed.has(name)) {
      failures.push(`${name} has no restricted-role evidence and is not in the baseline (restricted: NOSUPERUSER, NOBYPASSRLS, no SET-able membership): add a cell that sets it, or list it`);
    }
  }
  for (const name of listed) {
    if (!(name in grants)) failures.push(`${name} is in the baseline but is not a BYPASS_GRANT member`);
    else if (!unexercised.has(name)) failures.push(`${name} is in the baseline but now has evidence: remove it`);
  }
  return { failures, tally };
}

export function parseBaseline(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

export function parseEvidenceFile(text: string): { lines: unknown[]; errors: string[] } {
  const lines: unknown[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    try {
      lines.push(JSON.parse(raw));
    } catch {
      errors.push(`evidence line ${i + 1} is not JSON`);
    }
  });
  return { lines, errors };
}

const BASELINE_HEADER = [
  "# BYPASS_GRANT members no restricted connection (NOSUPERUSER, NOBYPASSRLS, unable to change role)",
  "# set in the integration suite (C11).",
  "# Their enforcement rests on production observation, not on a suite run.",
  "# Regenerate: RLS_GRANT_EVIDENCE_FILE=<fresh file> npm run test:integration, then",
  "#   npm run check:rls-grant-evidence -- <file> --write",
  "",
];

function formatBaseline(names: readonly string[]): string {
  return [...BASELINE_HEADER, ...names, ""].join("\n");
}

function printTally(tally: EvidenceTally): void {
  console.log(
    `grant lines: ${tally.grantLines}; role lines: ${tally.roleLines}; ignored lines: ${tally.ignoredLines}; ` +
      `grant lines with an undescribed role (no evidence): ${tally.unknownRoleLines}` +
      (tally.unknownRoles.length > 0 ? ` (${tally.unknownRoles.join(", ")})` : ""),
  );
  console.log(`BYPASS_GRANT members: ${tally.members}; with evidence: ${tally.exercised}; unexercised: ${tally.unexercised.length}`);
}

function readEvidence(file: string | undefined): { lines: unknown[]; errors: string[] } | { fatal: string } {
  if (!file) return { fatal: "no evidence file: pass one, or set RLS_GRANT_EVIDENCE_FILE" };
  if (!existsSync(file)) return { fatal: `evidence file ${file} does not exist: the suite did not write it` };
  const parsed = parseEvidenceFile(readFileSync(file, "utf8"));
  if (parsed.lines.length === 0 && parsed.errors.length === 0) return { fatal: `evidence file ${file} is empty` };
  return parsed;
}

export function main(argv: readonly string[]): number {
  const write = argv.includes("--write");
  const baselineAt = argv.indexOf("--baseline");
  const baselinePath = baselineAt === -1 ? BASELINE_PATH : (argv[baselineAt + 1] ?? "");
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--baseline");
  const evidence = readEvidence(positional[0] ?? process.env.RLS_GRANT_EVIDENCE_FILE);
  if ("fatal" in evidence) {
    console.error(`check-rls-grant-evidence: ${evidence.fatal}`);
    return 1;
  }

  const grants = BYPASS_GRANT as Readonly<Record<string, GrantShape>>;
  if (write) {
    const { problems, tally } = analyzeGrantEvidence({ lines: evidence.lines, grants });
    const refusals = [...evidence.errors, ...problems];
    if (refusals.length > 0) {
      console.error(`check-rls-grant-evidence: refusing to write the baseline:\n${refusals.map((f) => `  - ${f}`).join("\n")}`);
      return 1;
    }
    writeFileSync(baselinePath, formatBaseline(tally.unexercised));
    printTally(tally);
    console.log(`wrote ${tally.unexercised.length} member(s) to ${baselinePath}`);
    return 0;
  }

  if (!existsSync(baselinePath)) {
    console.error(`check-rls-grant-evidence: baseline ${baselinePath} does not exist`);
    return 1;
  }
  const { failures, tally } = compareGrantEvidence({
    lines: evidence.lines,
    grants,
    baseline: parseBaseline(readFileSync(baselinePath, "utf8")),
  });
  failures.unshift(...evidence.errors);
  printTally(tally);
  if (failures.length > 0) {
    console.error(`check-rls-grant-evidence: ${failures.length} failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    return 1;
  }
  console.log("check-rls-grant-evidence: ok");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
