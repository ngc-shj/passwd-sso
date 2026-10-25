import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BIND_FILE_HEADER,
  SIGN_IN_REF_LABEL,
  describeSignInProviderRef,
  evidenceOf,
  formatBindFile,
  formatEvidence,
  groupLegacyAccounts,
  isInsideWorktree,
  isMajority,
  LEGACY_ACCOUNT_VERDICT,
  legacyAccountVerdict,
  parseBindFile,
  parseEvidence,
  refMappingFor,
  suggestedProvider,
  type BindFileRow,
  type ClaimEvidence,
} from "../lib/tenant-domain-binding";
import {
  deriveIdentifierPepper,
  providerRefOf,
  resetIdentifierPepperForTests,
} from "@/lib/audit/identifier-pepper";

const A = "saml-jackson-alpha";
const B = "saml-jackson-bravo";
const UNIVERSE = new Set([A, B, "google"]);
const TENANT = "0b6f8f2e-6a43-4c5e-9d7a-2b0d3f1e4a51";

function evidence(counts: Record<string, number>, none: number, total: number): ClaimEvidence {
  return { total, none, counts: new Map(Object.entries(counts)) };
}

function row(over: Partial<BindFileRow> = {}): BindFileRow {
  return {
    claim: "acme.example",
    tenantId: TENANT,
    evidence: evidence({ [A]: 2 }, 0, 2),
    flags: { createdBy: "signin", uuidClaim: false, operatorEvents: [], registerProvider: null },
    ...over,
  };
}

describe("member evidence", () => {
  it("formats providers sorted by id, zero counts omitted, then none and total", () => {
    expect(formatEvidence(evidence({ [B]: 1, google: 0, [A]: 3 }, 1, 4))).toBe(
      `${A}=3;${B}=1;none=1;total=4`,
    );
  });

  it("is identical for one membership read in two row orders", () => {
    const members = [
      { userId: "u1", providers: [A] },
      { userId: "u2", providers: [B, A] },
      { userId: "u3", providers: ["webauthn"] },
    ];
    const forward = formatEvidence(evidenceOf(members, UNIVERSE));
    const reversed = formatEvidence(
      evidenceOf([...members].reverse().map((m) => ({ ...m, providers: [...m.providers].reverse() })), UNIVERSE),
    );
    expect(forward).toBe(reversed);
    expect(forward).toBe(`${A}=2;${B}=1;none=1;total=3`);
  });

  it("counts a member once per provider however many accounts it holds there", () => {
    expect(formatEvidence(evidenceOf([{ userId: "u1", providers: [A, A] }], UNIVERSE))).toBe(`${A}=1;none=0;total=1`);
  });

  it("counts a member holding only providers outside the universe as none", () => {
    expect(formatEvidence(evidenceOf([{ userId: "u1", providers: ["email"] }], UNIVERSE))).toBe("none=1;total=1");
  });

  it("round-trips the canonical form and refuses every other spelling", () => {
    const text = `${A}=3;${B}=1;none=1;total=4`;
    expect(formatEvidence(parseEvidence(text) as ClaimEvidence)).toBe(text);
    for (const bad of [
      `${B}=1;${A}=3;none=1;total=4`,
      `${A}=0;none=1;total=1`,
      `${A}=3;total=4;none=1`,
      `${A}=3;none=1`,
      `${A}=03;none=1;total=4`,
      ` ${A}=3;none=1;total=4`,
      "",
    ]) {
      expect(parseEvidence(bad), bad).toBeNull();
    }
  });
});

describe("suggestedProvider", () => {
  it.each([
    ["unanimous members", evidence({ [A]: 3 }, 0, 3), A],
    ["one member", evidence({ [A]: 1 }, 0, 1), A],
    ["zero members", evidence({}, 0, 0), null],
    ["a member at no claim provider", evidence({ [A]: 2 }, 1, 3), null],
    ["a member at a second provider too", evidence({ [A]: 2, [B]: 1 }, 0, 2), null],
    ["a minority intruder", evidence({ [A]: 2, [B]: 1 }, 0, 3), null],
  ] as const)("%s", (_label, e, expected) => {
    expect(suggestedProvider(e)).toBe(expected);
  });
});

describe("isMajority", () => {
  it.each([
    [2, 4, false],
    [3, 4, true],
    [1, 2, false],
    [2, 3, true],
    [1, 1, true],
    [0, 0, false],
  ] as const)("%i of %i -> %s", (count, total, expected) => {
    expect(isMajority(count, total)).toBe(expected);
  });
});

describe("bind file", () => {
  const PROVIDERS = new Set([A, B]);

  it("round-trips its own output", () => {
    const parsed = parseBindFile(formatBindFile([row(), row({ claim: "beta.example", evidence: evidence({}, 0, 0) })]), PROVIDERS);
    expect(parsed).toEqual({
      ok: true,
      lines: [
        expect.objectContaining({ claim: "acme.example", tenantId: TENANT, provider: A, evidence: `${A}=2;none=0;total=2` }),
        expect.objectContaining({ claim: "beta.example", provider: null, evidence: "none=0;total=0" }),
      ],
    });
  });

  it.each([
    ["a newline and a valid TSV line", `x\nevil.example\t${TENANT}\t${B}\t${B}=1;none=0;total=1`],
    ["a tab", "ops\tadmin"],
    ["a bidi override", `ops${String.fromCodePoint(0x202e)}admin`],
  ])("a created_by holding %s yields exactly one data line per row", (_label, createdBy) => {
    const text = formatBindFile([row({ flags: { ...row().flags, createdBy } }), row({ claim: "beta.example" })]);
    const lines = text.split("\n").filter((l) => l !== "" && l !== BIND_FILE_HEADER);
    expect(lines.filter((l) => !l.startsWith("#"))).toHaveLength(2);
    // No stored value ends a line or a column: comment lines carry no tab and
    // no unsafe character.
    expect(lines.filter((l) => l.startsWith("#") && /[\t\u202e]/.test(l))).toEqual([]);
    expect(text).not.toContain(String.fromCodePoint(0x202e));
    const parsed = parseBindFile(text, PROVIDERS);
    expect(parsed.ok && parsed.lines.map((l) => l.claim)).toEqual(["acme.example", "beta.example"]);
  });

  // A stored claim may start with "#" (printable ASCII); its data line would
  // read back as a comment and drop out of --apply without a word.
  it("lists a claim starting with # in a not-written note instead of as a data line", () => {
    const text = formatBindFile([row({ claim: "#acme" }), row({ claim: "acme.example" })]);
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("#acme\t"))).toEqual([]);
    expect(text).toMatch(/^# Not written: 1 claim\(s\) starting with "#"/m);
    expect(lines).toContain(`#   #acme (tenant ${TENANT})`);
    const parsed = parseBindFile(text, PROVIDERS);
    expect(parsed.ok && parsed.lines.map((l) => l.claim)).toEqual(["acme.example"]);
  });

  it("writes no not-written note when every claim is writable", () => {
    const text = formatBindFile([row({ claim: "acme.example" })]);
    expect(text).not.toContain("Not written");
    const parsed = parseBindFile(text, PROVIDERS);
    expect(parsed.ok && parsed.lines.map((l) => l.claim)).toEqual(["acme.example"]);
  });

  it("puts the flags on a comment line above the data line", () => {
    const lines = formatBindFile([
      row({ flags: { createdBy: "backfill", uuidClaim: true, operatorEvents: ["reassign"], registerProvider: A } }),
    ]).split("\n");
    const data = lines.findIndex((l) => l.startsWith("acme.example\t"));
    expect(lines[data - 1]).toBe(
      `# acme.example: created_by=backfill; uuid_claim=yes; operator_events=reassign; register_provider=${A}`,
    );
  });

  const valid = (body: string) => `${BIND_FILE_HEADER}\n# comment\n${body}\n`;
  const line = (claim: string, provider: string) => `${claim}\t${TENANT}\t${provider}\t${A}=1;none=0;total=1`;

  it("accepts a well-formed file (the allow side of every refusal below)", () => {
    const parsed = parseBindFile(valid(`${line("acme.example", A)}\n${line("beta.example", "")}`), PROVIDERS);
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["a malformed line", valid(`acme.example\t${TENANT}\t${A}`), /expected 4 tab-separated columns, got 3/],
    ["a duplicate claim", valid(`${line("acme.example", A)}\n${line("acme.example", B)}`), /already appears on line 3/],
    ["an unknown header version", valid(line("acme.example", A)).replace("\tv1", "\tv2"), /unknown bind file version "v2"/],
    ["a missing header", `${line("acme.example", A)}\n`, /expected the header/],
    ["an unconfigured provider", valid(line("acme.example", "saml-jackson-gone")), /"saml-jackson-gone" is not a configured claim provider/],
    ["a control character", valid(line(`acme${String.fromCodePoint(0x7f)}.example`, A)), /claim contains a control.*"acme<U\+007F>\.example"/],
    ["a bidi character in the provider", valid(line("acme.example", `${A}${String.fromCodePoint(0x202e)}`)), /provider contains a control.*<U\+202E>/],
    ["a non-canonical evidence", valid(`acme.example\t${TENANT}\t${A}\tnone=0;total=1;${A}=1`), /not in the canonical form/],
    ["a tenant that is not a UUID", valid(`acme.example\tacme\t${A}\t${A}=1;none=0;total=1`), /is not a UUID/],
    ["CRLF line endings", valid(line("acme.example", A)).replaceAll("\n", "\r\n"), /CRLF line endings: save it with LF line endings, no BOM/],
    ["a leading byte-order mark", `\uFEFF${valid(line("acme.example", A))}`, /byte-order mark: save it with LF line endings, no BOM/],
    ["a lone carriage return inside a cell", valid(line("acme\r.example", A)), /claim contains a control.*<U\+000D>/],
  ])("refuses the whole file on %s", (_label, text, message) => {
    const parsed = parseBindFile(text, PROVIDERS);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join("\n")).toMatch(message);
    expect(parsed.errors.join("\n")).not.toMatch(/[\u007f‮]/);
  });
});

describe("isInsideWorktree", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bind-worktree-")));
    repo = join(root, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    mkdirSync(join(root, "repo-other"));
    mkdirSync(join(root, "outside"));
    symlinkSync(join(repo, "sub"), join(root, "outside", "link"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ["a file at the top", () => join(repo, "bind.tsv"), true],
    ["a file in a subdirectory", () => join(repo, "sub", "bind.tsv"), true],
    ["a symlinked parent", () => join(root, "outside", "link", "bind.tsv"), true],
    ["a .. that climbs back in", () => `${join(root, "outside")}/../repo/bind.tsv`, true],
    ["a path outside the repository", () => join(root, "outside", "bind.tsv"), false],
    ["a sibling whose name extends the repository's", () => join(root, "repo-other", "bind.tsv"), false],
  ] as const)("%s -> %s", (_label, target, expected) => {
    expect(isInsideWorktree(target(), repo)).toBe(expected);
  });

  it("throws when the target's directory does not exist", () => {
    expect(() => isInsideWorktree(join(root, "missing", "bind.tsv"), repo)).toThrow();
  });
});

describe("sign-in provider refs", () => {
  const PEPPER_ENV = { AUDIT_IDENTIFIER_PEPPER: "binding-unit-pepper-0123456789abcdef0123" };

  afterEach(() => {
    vi.unstubAllEnvs();
    resetIdentifierPepperForTests();
  });

  it("maps the ref the app stores back to its provider id, under one env", () => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", PEPPER_ENV.AUDIT_IDENTIFIER_PEPPER);
    resetIdentifierPepperForTests();
    const appRef = providerRefOf(B);
    const mapping = refMappingFor([A, B], deriveIdentifierPepper(process.env));
    expect(describeSignInProviderRef(appRef, mapping)).toBe(B);
  });

  it("names a ref of a removed provider unknown, not some configured one", () => {
    const pepper = deriveIdentifierPepper(PEPPER_ENV);
    const removed = refMappingFor(["saml-jackson-gone"], pepper);
    // Narrowed by assertion, not by a fallback: an empty ref would make the
    // expectation below compare "unknown (ref )" with itself.
    expect(removed.kind).toBe("map");
    if (removed.kind !== "map") return;
    const ref = [...removed.idByRef.keys()][0];
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(describeSignInProviderRef(ref, refMappingFor([A, B], pepper))).toBe(
      `${SIGN_IN_REF_LABEL.UNKNOWN} (ref ${ref})`,
    );
  });

  it("says unmappable without a pepper, distinct from unknown", () => {
    expect(describeSignInProviderRef("0123456789abcdef", refMappingFor([A], null))).toBe(
      `${SIGN_IN_REF_LABEL.NO_PEPPER} (ref 0123456789abcdef)`,
    );
  });

  it("says unmappable without a configured provider", () => {
    expect(describeSignInProviderRef("0123456789abcdef", refMappingFor([], deriveIdentifierPepper(PEPPER_ENV)))).toBe(
      `${SIGN_IN_REF_LABEL.NO_PROVIDERS} (ref 0123456789abcdef)`,
    );
  });

  it("says no ref was stored when the row carries none", () => {
    expect(describeSignInProviderRef(null, refMappingFor([A], deriveIdentifierPepper(PEPPER_ENV)))).toBe(
      SIGN_IN_REF_LABEL.NO_REF,
    );
  });
});

describe("legacy-accounts grouping and verdict", () => {
  const T1 = "11111111-1111-4111-8111-111111111111";
  const T2 = "22222222-2222-4222-8222-222222222222";
  const active = new Map([["u1", T1], ["u2", T1], ["u3", T2]]);

  it("groups accounts by their user's active tenant, counting users once, users active nowhere last", () => {
    const accounts = [{ userId: "u3" }, { userId: "u1" }, { userId: "u1" }, { userId: "u2" }, { userId: "gone" }];
    expect(groupLegacyAccounts(accounts, active)).toEqual([
      { tenantId: T1, users: 2, accounts: 3 },
      { tenantId: T2, users: 1, accounts: 1 },
      { tenantId: null, users: 1, accounts: 1 },
    ]);
  });

  it("is none without accounts, whether or not the legacy provider is configured", () => {
    expect(legacyAccountVerdict([], true)).toBe(LEGACY_ACCOUNT_VERDICT.NONE);
    expect(legacyAccountVerdict([], false)).toBe(LEGACY_ACCOUNT_VERDICT.NONE);
  });

  it("passes one group and refuses two, with the legacy provider configured", () => {
    const one = groupLegacyAccounts([{ userId: "u1" }, { userId: "u2" }], active);
    const two = groupLegacyAccounts([{ userId: "u1" }, { userId: "u3" }], active);
    expect(legacyAccountVerdict(one, true)).toBe(LEGACY_ACCOUNT_VERDICT.ONE_GROUP);
    expect(legacyAccountVerdict(two, true)).toBe(LEGACY_ACCOUNT_VERDICT.SPANS);
  });

  it("counts users active nowhere as a group of their own", () => {
    const groups = groupLegacyAccounts([{ userId: "u1" }, { userId: "gone" }], active);
    expect(legacyAccountVerdict(groups, true)).toBe(LEGACY_ACCOUNT_VERDICT.SPANS);
    expect(legacyAccountVerdict(groupLegacyAccounts([{ userId: "gone" }], active), true)).toBe(
      LEGACY_ACCOUNT_VERDICT.ONE_GROUP,
    );
  });

  it("is unresolved, not refused, when the legacy provider is not configured", () => {
    const two = groupLegacyAccounts([{ userId: "u1" }, { userId: "u3" }], active);
    expect(legacyAccountVerdict(two, false)).toBe(LEGACY_ACCOUNT_VERDICT.UNRESOLVED);
  });
});
