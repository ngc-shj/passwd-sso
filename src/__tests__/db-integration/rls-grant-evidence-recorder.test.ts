import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionRole, parseSetBypassGucs } from "./rls-grant-evidence-recorder";

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

describe("connectionRole", () => {
  it("is the login user when the options set no role", () => {
    expect(connectionRole({ user: "passwd_app" })).toBe("passwd_app");
    expect(connectionRole({ user: "passwd_app", options: "-c search_path=public" })).toBe("passwd_app");
    expect(connectionRole({ user: "passwd_app", options: "-c search_path=role=x" })).toBe("passwd_app");
  });

  const SETTINGS = ["role", "session_authorization"];
  const FORMS: [string, (name: string) => string][] = [
    ["-c with a space", (n) => `-c ${n}=x`],
    ["-c without a space", (n) => `-c${n}=x`],
    ["two dashes", (n) => `--${n}=x`],
  ];
  const CASES: [string, (name: string) => string][] = [
    ["lower case", (n) => n],
    ["upper case", (n) => n.toUpperCase()],
  ];
  it.each(
    SETTINGS.flatMap((setting) =>
      FORMS.flatMap(([form, spell]) => CASES.map(([letters, cased]) => [setting, form, letters, spell(cased(setting))] as const)),
    ),
  )("is the sentinel for %s set with %s, %s (%s)", (_setting, _form, _letters, option) => {
    expect(connectionRole({ user: "passwd_user", options: option })).toBe("<role set in startup options>");
    expect(connectionRole({ user: "passwd_user", options: `-c search_path=public ${option}` })).toBe("<role set in startup options>");
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

  const recordedRoles = () =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).role);

  it("records a grant under the login user", () => {
    record({ user: "rls_probe_1_ab" }, ["SELECT 1"]);
    record({ user: "rls_probe_1_ab" }, [STATEMENT, GRANT_VALUES]);
    expect(recordedRoles()).toEqual(["rls_probe_1_ab"]);
  });

  it("records a grant of a connection whose options set a role under the sentinel, not the login user", () => {
    record({ user: "passwd_user", options: "-c role=rls_probe_1_ab" }, [STATEMENT, GRANT_VALUES]);
    expect(recordedRoles()).toEqual(["<role set in startup options>"]);
  });

  it("records one line per distinct (purpose, tables, role)", () => {
    record({ user: "a" }, [STATEMENT, GRANT_VALUES]);
    record({ user: "a" }, [STATEMENT, GRANT_VALUES]);
    record({ user: "b" }, [STATEMENT, GRANT_VALUES]);
    record({ user: "a" }, [STATEMENT, ["system_maintenance", "00000000-0000-0000-0000-000000000000", "users"]]);
    expect(recordedRoles()).toEqual(["a", "b", "a"]);
  });

  it("records nothing for a statement that is not the bypass statement, or without a connection", () => {
    record({ user: "a" }, ["SELECT set_config('role', 'x', false)"]);
    record(undefined, [STATEMENT, GRANT_VALUES]);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });
});
