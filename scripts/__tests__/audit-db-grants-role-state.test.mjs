/**
 * DB-free tests for the role-state predicate in scripts/audit-db-grants.mjs.
 *
 * roleStateViolations decides which audit keys may never be recorded by
 * `--write` and are always a finding in compare mode: an elevated attribute or
 * a membership on any audited role, a PUBLIC table grant, and a retired role
 * that can log in, be acted as, or hold anything beyond what PUBLIC holds.
 * Each deny row below sits next to the adjacent allow it must not swallow.
 *
 * Also pinned against the COMMITTED manifest, and the cross-file contract that
 * every converged role (bootstrap-rds-roles.mjs ROLES) is exactly the audited
 * roles that are not retired.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  roleStateViolations,
  assertRetiredSubset,
  creatorGrantKeys,
  AUDITED_ROLES,
  RETIRED_ROLES,
} from "../audit-db-grants.mjs";
// Has a main guard, so importing it does not connect.
import { ROLES } from "../bootstrap-rds-roles.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(__dirname, "..", "checks", "db-grants-manifest.json");

const LIVE = "passwd_app";
const RETIRED = "passwd_dcr_cleanup_worker";
const PROBE = "some_probe_role";
const SCOPE = { auditedRoles: [LIVE, RETIRED], retiredRoles: [RETIRED] };

const ELEVATED = ["rolsuper", "rolbypassrls", "rolreplication", "rolcreatedb", "rolcreaterole"];

/**
 * [label, key under test, the other keys present, expected: is it a violation].
 * The companion keys model the PUBLIC counterparts the predicate exempts on.
 */
const ROWS = [
  // ROLEATTR — elevated attributes, every audited role.
  ...ELEVATED.flatMap((attr) => [
    [`${attr} true on a live role`, `ROLEATTR:${LIVE}\t${attr}\ttrue`, [], true],
    [`${attr} false on a live role`, `ROLEATTR:${LIVE}\t${attr}\tfalse`, [], false],
    [`${attr} true on the retired role`, `ROLEATTR:${RETIRED}\t${attr}\ttrue`, [], true],
  ]),
  ["rolsuper true on a role outside the audit", `ROLEATTR:${PROBE}\trolsuper\ttrue`, [], false],
  // ROLEATTR — LOGIN is legitimate for a live role only.
  ["rolcanlogin true on a live role", `ROLEATTR:${LIVE}\trolcanlogin\ttrue`, [], false],
  ["rolcanlogin true on the retired role", `ROLEATTR:${RETIRED}\trolcanlogin\ttrue`, [], true],
  ["rolcanlogin false on the retired role", `ROLEATTR:${RETIRED}\trolcanlogin\tfalse`, [], false],

  // MEMBER — an audited role as member, whatever the flags.
  ["live role as member", `MEMBER:${LIVE}\t${PROBE}\tadmin=f,inherit=t,set=t`, [], true],
  ["live role as admin-only member", `MEMBER:${LIVE}\t${PROBE}\tadmin=t,inherit=f,set=f`, [], true],
  ["retired role as member", `MEMBER:${RETIRED}\t${PROBE}\tadmin=f,inherit=t,set=t`, [], true],
  // MEMBER — membership IN the retired role.
  ["inherit+set member of the retired role", `MEMBER:${PROBE}\t${RETIRED}\tadmin=f,inherit=t,set=t`, [], true],
  ["inherit-only member of the retired role", `MEMBER:${PROBE}\t${RETIRED}\tadmin=f,inherit=t,set=f`, [], true],
  ["set-only member of the retired role", `MEMBER:${PROBE}\t${RETIRED}\tadmin=f,inherit=f,set=t`, [], true],
  ["admin+inherit member of the retired role", `MEMBER:${PROBE}\t${RETIRED}\tadmin=t,inherit=t,set=f`, [], true],
  ["admin-only member of the retired role (PG16 creator grant)", `MEMBER:${PROBE}\t${RETIRED}\tadmin=t,inherit=f,set=f`, [], false],
  ["no-option member of the retired role", `MEMBER:${PROBE}\t${RETIRED}\tadmin=f,inherit=f,set=f`, [], false],
  ["member of a non-retired role, outside the audit", `MEMBER:${PROBE}\tother_role\tadmin=f,inherit=t,set=t`, [], false],
  // MEMBER — anything that does not parse is a violation, never an allow.
  ["MEMBER key with two fields", `MEMBER:${PROBE}\t${RETIRED}`, [], true],
  ["MEMBER key with a truncated flag field", `MEMBER:${PROBE}\t${RETIRED}\tadmin=t,inherit=f`, [], true],
  ["MEMBER key with a trailing flag", `MEMBER:${PROBE}\t${RETIRED}\tadmin=t,inherit=f,set=f,x=f`, [], true],
  ["MEMBER key with upper-case flags", `MEMBER:${PROBE}\t${RETIRED}\tadmin=T,inherit=F,set=F`, [], true],
  [
    "MEMBER key whose member name contains a tab",
    `MEMBER:evil\tname\t${RETIRED}\tadmin=t,inherit=f,set=f`,
    [],
    true,
  ],

  // PUBLIC table grants reach every role.
  ["PUBLIC table grant", "PUBLIC:public.accounts\tSELECT", [], true],

  // TABLE / SEQUENCE / SCHEMA / DATABASE / FUNCTION on the retired role:
  // a violation unless PUBLIC holds the same thing.
  ["retired TABLE without a PUBLIC counterpart", `TABLE:${RETIRED}\tpublic.tenants\tSELECT`, [], true],
  [
    "retired TABLE held by PUBLIC too",
    `TABLE:${RETIRED}\tpublic.tenants\tSELECT`,
    ["PUBLIC:public.tenants\tSELECT"],
    false,
  ],
  [
    "retired TABLE with a PUBLIC counterpart for another privilege",
    `TABLE:${RETIRED}\tpublic.tenants\tDELETE`,
    ["PUBLIC:public.tenants\tSELECT"],
    true,
  ],
  ["live TABLE", `TABLE:${LIVE}\tpublic.tenants\tSELECT`, [], false],
  [
    "TABLE on a role whose name extends the retired one",
    `TABLE:${RETIRED}_x\tpublic.tenants\tSELECT`,
    [],
    false,
  ],
  ["retired SEQUENCE without a PUBLIC counterpart", `SEQUENCE:${RETIRED}\tpublic.s\tUSAGE`, [], true],
  [
    "retired SEQUENCE held by PUBLIC too",
    `SEQUENCE:${RETIRED}\tpublic.s\tUSAGE`,
    ["SEQUENCE:public\tpublic.s\tUSAGE"],
    false,
  ],
  ["retired SCHEMA USAGE without a PUBLIC counterpart", `SCHEMA:${RETIRED}\tpublic\tUSAGE`, [], true],
  [
    "retired SCHEMA USAGE held by PUBLIC too",
    `SCHEMA:${RETIRED}\tpublic\tUSAGE`,
    ["SCHEMA:public\tpublic\tUSAGE"],
    false,
  ],
  [
    "retired SCHEMA CREATE while PUBLIC holds only USAGE",
    `SCHEMA:${RETIRED}\tpublic\tCREATE`,
    ["SCHEMA:public\tpublic\tUSAGE"],
    true,
  ],
  ["live SCHEMA USAGE", `SCHEMA:${LIVE}\tpublic\tUSAGE`, [], false],
  ["retired DATABASE CONNECT", `DATABASE:${RETIRED}\tpasswd_sso\tCONNECT`, ["DATABASE:public\tpasswd_sso\tTEMP"], true],
  [
    "retired DATABASE TEMP held by PUBLIC too",
    `DATABASE:${RETIRED}\tpasswd_sso\tTEMP`,
    ["DATABASE:public\tpasswd_sso\tTEMP"],
    false,
  ],
  ["live DATABASE CONNECT", `DATABASE:${LIVE}\tpasswd_sso\tCONNECT`, [], false],
  ["retired FUNCTION without a PUBLIC counterpart", `FUNCTION:${RETIRED}\tpublic.rls_bypass_enforced()\tEXECUTE`, [], true],
  [
    "retired FUNCTION held by PUBLIC too",
    `FUNCTION:${RETIRED}\tpublic.f()\tEXECUTE`,
    ["FUNCTION:public\tpublic.f()\tEXECUTE"],
    false,
  ],
  [
    "retired SECURITY_DEFINER FUNCTION held by PUBLIC too",
    `FUNCTION:${RETIRED}\tpublic.f()\tEXECUTE\tSECURITY_DEFINER`,
    ["FUNCTION:public\tpublic.f()\tEXECUTE\tSECURITY_DEFINER"],
    false,
  ],
  [
    "retired SECURITY_DEFINER FUNCTION against a counterpart without the suffix",
    `FUNCTION:${RETIRED}\tpublic.f()\tEXECUTE\tSECURITY_DEFINER`,
    ["FUNCTION:public\tpublic.f()\tEXECUTE"],
    true,
  ],
  ["live FUNCTION", `FUNCTION:${LIVE}\tpublic.rls_bypass_enforced()\tEXECUTE`, [], false],

  // COLUMN on the retired role: no PUBLIC column counterpart exists.
  [
    "retired COLUMN, even beside a PUBLIC table grant",
    `COLUMN:${RETIRED}\tpublic.tenants.name\tSELECT`,
    ["PUBLIC:public.tenants\tSELECT"],
    true,
  ],
  ["live COLUMN", `COLUMN:${LIVE}\tpublic.tenants.name\tUPDATE`, [], false],

  // DEFAULTACL: the grantee of the ACL item decides.
  ["default ACL granting the retired role", `DEFAULTACL:passwd_user\tpublic\tr\t${RETIRED}=r/passwd_user`, [], true],
  ["default ACL granting a live role", `DEFAULTACL:passwd_user\tpublic\tr\t${LIVE}=arwd/passwd_user`, [], false],
  ["default ACL granting PUBLIC", "DEFAULTACL:passwd_user\t-\tf\t=X/passwd_user", [], false],
  [
    "default ACL granting a role whose name extends the retired one",
    `DEFAULTACL:passwd_user\tpublic\tr\t${RETIRED}_x=r/passwd_user`,
    [],
    false,
  ],
];

describe("roleStateViolations", () => {
  it.each(ROWS)("%s", (_label, key, companions, violates) => {
    const out = roleStateViolations([key, ...companions], SCOPE);
    expect(out.includes(key)).toBe(violates);
  });

  it("matches a quoted default-ACL grantee, embedded quotes included", () => {
    const scope = { auditedRoles: ['dcr "old" role'], retiredRoles: ['dcr "old" role'] };
    const key = 'DEFAULTACL:passwd_user\tpublic\tr\t"dcr ""old"" role"=r/passwd_user';
    expect(roleStateViolations([key], scope)).toEqual([key]);
    // Adjacent allow: a different quoted grantee.
    const other = 'DEFAULTACL:passwd_user\tpublic\tr\t"dcr ""new"" role"=r/passwd_user';
    expect(roleStateViolations([other], scope)).toEqual([]);
  });

  it("reports nothing for a retired role at rest", () => {
    // The state migration 20261023010000 leaves: NOLOGIN, and only what
    // PUBLIC holds, plus PostgreSQL 16's ADMIN-only creator row.
    const atRest = [
      ...ELEVATED.map((attr) => `ROLEATTR:${RETIRED}\t${attr}\tfalse`),
      `ROLEATTR:${RETIRED}\trolcanlogin\tfalse`,
      `DATABASE:${RETIRED}\tpasswd_sso\tTEMP`,
      "DATABASE:public\tpasswd_sso\tTEMP",
      `SCHEMA:${RETIRED}\tpublic\tUSAGE`,
      "SCHEMA:public\tpublic\tUSAGE",
      `FUNCTION:${RETIRED}\tpublic.enforce_tenant_id_from_context()\tEXECUTE`,
      "FUNCTION:public\tpublic.enforce_tenant_id_from_context()\tEXECUTE",
      `MEMBER:rds_master\t${RETIRED}\tadmin=t,inherit=f,set=f`,
    ];
    expect(roleStateViolations(atRest, SCOPE)).toEqual([]);
  });
});

describe("creatorGrantKeys", () => {
  // Exactly the ADMIN-only membership of a non-audited role in a retired role:
  // PostgreSQL 16's creator grant, present only where a NOSUPERUSER CREATEROLE
  // role (the RDS master) created the role, so the manifest cannot carry it.
  const creator = `MEMBER:${PROBE}\t${RETIRED}\tadmin=t,inherit=f,set=f`;

  it("selects the creator grant", () => {
    expect(creatorGrantKeys([creator], SCOPE)).toEqual([creator]);
  });

  it.each([
    ["one that can confer the role", `MEMBER:${PROBE}\t${RETIRED}\tadmin=t,inherit=t,set=f`],
    ["one with set", `MEMBER:${PROBE}\t${RETIRED}\tadmin=t,inherit=f,set=t`],
    ["one without admin", `MEMBER:${PROBE}\t${RETIRED}\tadmin=f,inherit=f,set=f`],
    ["an audited member's", `MEMBER:${LIVE}\t${RETIRED}\tadmin=t,inherit=f,set=f`],
    ["one into a live role", `MEMBER:${PROBE}\t${LIVE}\tadmin=t,inherit=f,set=f`],
    ["a malformed key", `MEMBER:${PROBE}\tx\t${RETIRED}\tadmin=t,inherit=f,set=f`],
  ])("leaves %s in the comparison", (_label, key) => {
    expect(creatorGrantKeys([key], SCOPE)).toEqual([]);
  });
});

describe("assertRetiredSubset", () => {
  it("accepts retired roles that are all audited", () => {
    expect(() => assertRetiredSubset(["a", "b"], ["b"])).not.toThrow();
  });

  it("refuses a retired role the audit does not read", () => {
    expect(() => assertRetiredSubset(["a"], ["a", "b"])).toThrow(/RETIRED_ROLE_UNAUDITED: b\b/);
  });

  it("accepts the committed role lists", () => {
    expect(() => assertRetiredSubset(AUDITED_ROLES, RETIRED_ROLES)).not.toThrow();
  });
});

describe("committed manifest and role lists", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

  it("records no role-state violation", () => {
    const out = roleStateViolations(manifest.grants, {
      auditedRoles: AUDITED_ROLES,
      retiredRoles: RETIRED_ROLES,
    });
    expect(out).toEqual([]);
  });

  it("records the anchor publisher as LOGIN and the DCR role as retired", () => {
    // Anti-vacuity for the case above: both roles really are in the manifest.
    expect(manifest.grants).toContain("ROLEATTR:passwd_anchor_publisher\trolcanlogin\ttrue");
    expect(manifest.grants).toContain("ROLEATTR:passwd_dcr_cleanup_worker\trolcanlogin\tfalse");
  });

  it("converges exactly the audited roles that are not retired", () => {
    const converged = ROLES.map((r) => r.name).sort();
    const expected = AUDITED_ROLES.filter((r) => !RETIRED_ROLES.includes(r)).sort();
    expect(converged).toEqual(expected);
    // Named, so shrinking both lists together cannot pass.
    expect(converged).toContain("passwd_anchor_publisher");
    expect(RETIRED_ROLES).toContain("passwd_dcr_cleanup_worker");
  });
});
