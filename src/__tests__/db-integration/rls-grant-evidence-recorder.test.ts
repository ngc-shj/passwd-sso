import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveRole, parseSetBypassGucs } from "./rls-grant-evidence-recorder";

// The statement setBypassGucs sends (src/lib/tenant-rls-grants.ts), as Prisma binds it.
const STATEMENT = `SELECT set_config('app.bypass_rls', 'on', true),
                              set_config('app.bypass_purpose', $1, true),
                              set_config('app.tenant_id', $2, true),
                              set_config('app.bypass_tables', $3, true)`;

describe("parseSetBypassGucs", () => {
  it("reads the purpose and the table list from the bound values, never the tenant id", () => {
    expect(parseSetBypassGucs([STATEMENT, ["system_maintenance", "00000000-0000-0000-0000-000000000000", "a,b"]])).toEqual({
      purpose: "system_maintenance",
      tables: "a,b",
    });
  });

  it("reads a query config object", () => {
    expect(parseSetBypassGucs([{ text: STATEMENT, values: ["audit_write", "tenant", "t"] }])).toEqual({ purpose: "audit_write", tables: "t" });
  });

  it("ignores any other statement, including one that sets the bypass differently", () => {
    expect(parseSetBypassGucs(["SELECT 1", []])).toBeNull();
    expect(
      parseSetBypassGucs([
        `SELECT set_config('app.bypass_rls', 'on', true), set_config('app.bypass_purpose', $1, true), set_config('app.bypass_tables', $2, true)`,
        ["p", "t"],
      ]),
    ).toBeNull();
  });

  it("ignores the statement with the wrong number of values", () => {
    expect(parseSetBypassGucs([STATEMENT, ["p", "t"]])).toBeNull();
    expect(parseSetBypassGucs([STATEMENT])).toBeNull();
  });
});

describe("effectiveRole", () => {
  it("is the role set through the connection's options when present", () => {
    expect(effectiveRole({ user: "passwd_user", options: "-c role=rls_probe_1_ab" })).toBe("rls_probe_1_ab");
    expect(effectiveRole({ user: "passwd_user", options: "-c search_path=public -c role=probe" })).toBe("probe");
  });

  it("is the connection user otherwise", () => {
    expect(effectiveRole({ user: "passwd_app" })).toBe("passwd_app");
    expect(effectiveRole({ user: "passwd_app", options: "-c search_path=public" })).toBe("passwd_app");
  });

  it("is the last role option when several are given", () => {
    expect(effectiveRole({ user: "passwd_user", options: "-c role=first -c role=second" })).toBe("second");
  });
});

describe("recordGrantEvidence", () => {
  const GRANT_VALUES = ["system_maintenance", "00000000-0000-0000-0000-000000000000", "tenants"];
  let dir: string;
  let file: string;
  let record: typeof import("./rls-grant-evidence-recorder").recordGrantEvidence;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "grant-evidence-"));
    file = join(dir, "evidence.jsonl");
    vi.stubEnv("RLS_GRANT_EVIDENCE_FILE", file);
    // A fresh module per cell: the recorder dedupes per process.
    vi.resetModules();
    record = (await import("./rls-grant-evidence-recorder")).recordGrantEvidence;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const probe = () => ({ connectionParameters: { user: "passwd_user", options: "-c role=rls_probe_1_ab" } });
  const recordedRoles = () =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).role);

  it("records a grant under the probe role when the connection never switches role", () => {
    const client = probe();
    record(client, ["SELECT 1"]);
    record(client, [STATEMENT, GRANT_VALUES]);
    expect(recordedRoles()).toEqual(["rls_probe_1_ab"]);
  });

  it.each([
    ["SET ROLE", "SET ROLE passwd_user"],
    ["SET LOCAL ROLE with leading whitespace, lower case", "  \n set local role passwd_user"],
    ["SET SESSION ROLE", "SET SESSION ROLE passwd_user"],
    ["RESET ROLE", "RESET ROLE"],
    ["SET SESSION AUTHORIZATION", "SET SESSION AUTHORIZATION passwd_user"],
    ["a later statement of a batch", "BEGIN; SET ROLE passwd_user"],
    ["set_config on role", "SELECT set_config('role', 'passwd_user', false)"],
  ])("does not record the probe role once the connection ran %s", (_name, statement) => {
    const client = probe();
    record(client, [{ text: statement }]);
    record(client, [STATEMENT, GRANT_VALUES]);
    expect(recordedRoles()).toEqual(["<role switched after connect>"]);
  });

  it("marks only the connection that switched", () => {
    const switched = probe();
    const other = probe();
    record(switched, ["RESET ROLE"]);
    record(other, [STATEMENT, GRANT_VALUES]);
    record(switched, [STATEMENT, GRANT_VALUES]);
    expect(recordedRoles()).toEqual(["rls_probe_1_ab", "<role switched after connect>"]);
  });
});

