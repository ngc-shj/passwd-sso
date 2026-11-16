/**
 * DB-free tests for the parameter-privilege class in scripts/audit-db-grants.mjs.
 *
 * An audited role able to SET session_replication_role (or ALTER SYSTEM it, or
 * carrying it as a role default) can disable triggers, and with them the
 * departed-member guard. No such key is ever expected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parameterKey, parameterViolations } from "../audit-db-grants.mjs";

const MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "checks", "db-grants-manifest.json");
const OTHER = "TABLE:passwd_app\tpublic.users\tSELECT";

describe("parameterViolations", () => {
  it.each([
    ["SET", "SET"],
    ["ALTER SYSTEM", "ALTER SYSTEM"],
    ["a role default", "ROLE_DEFAULT"],
  ])("flags a %s key", (_label, priv) => {
    const key = parameterKey("passwd_app", "session_replication_role", priv);
    expect(key).toBe(`PARAMETER:passwd_app\tsession_replication_role\t${priv}`);
    expect(parameterViolations([OTHER, key])).toEqual([key]);
  });

  it("returns nothing when no parameter key is present", () => {
    expect(parameterViolations([OTHER])).toEqual([]);
    expect(parameterViolations([])).toEqual([]);
  });

  it("is empty for the committed manifest", () => {
    const { grants } = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(parameterViolations(grants)).toEqual([]);
  });
});
