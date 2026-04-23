import { describe, it, expect } from "vitest";
import {
  extractHkdfInfoStrings,
  extractAadScopes,
  parseLedgerHkdfInfo,
  parseLedgerAadScopes,
} from "../checks/check-crypto-domains.mjs";

describe("extractHkdfInfoStrings", () => {
  it("extracts HKDF info strings from source code", () => {
    const code = `
const INFO = "passwd-sso-enc-v1";
const AUTH = 'passwd-sso-auth-v1';
`;
    expect(extractHkdfInfoStrings(code)).toEqual([
      "passwd-sso-enc-v1",
      "passwd-sso-auth-v1",
    ]);
  });

  it("skips commented-out lines (// comments)", () => {
    const code = `
// const RESERVED = "passwd-sso-future-v1";
const ACTIVE = "passwd-sso-enc-v1";
`;
    expect(extractHkdfInfoStrings(code)).toEqual(["passwd-sso-enc-v1"]);
  });

  it("skips block comment lines (* prefix)", () => {
    const code = `
/**
 * Reserved: "passwd-sso-reserved-v2"
 */
const ACTIVE = "passwd-sso-enc-v1";
`;
    expect(extractHkdfInfoStrings(code)).toEqual(["passwd-sso-enc-v1"]);
  });

  it("deduplicates identical strings", () => {
    const code = `
const A = "passwd-sso-enc-v1";
const B = "passwd-sso-enc-v1";
`;
    expect(extractHkdfInfoStrings(code)).toEqual(["passwd-sso-enc-v1"]);
  });

  it("returns empty array when no matches", () => {
    expect(extractHkdfInfoStrings("const x = 42;")).toEqual([]);
  });
});

describe("extractAadScopes", () => {
  it("extracts AAD scope constants", () => {
    const code = `
const SCOPE_PERSONAL = "PV";
const AAD_SCOPE_TEAM = "TE";
`;
    expect(extractAadScopes(code).sort()).toEqual(["PV", "TE"]);
  });

  it("returns empty array when no matches", () => {
    expect(extractAadScopes("const x = 42;")).toEqual([]);
  });
});

describe("parseLedgerHkdfInfo", () => {
  it("extracts backtick-delimited info strings from markdown", () => {
    const md = `
| Domain | Info |
|--------|------|
| Vault  | \`passwd-sso-enc-v1\` |
| Auth   | \`passwd-sso-auth-v1\` |
`;
    expect(parseLedgerHkdfInfo(md).sort()).toEqual([
      "passwd-sso-auth-v1",
      "passwd-sso-enc-v1",
    ]);
  });
});

describe("parseLedgerAadScopes", () => {
  it("extracts AAD scopes from ledger table rows", () => {
    const md = `
| \`PV\` | Personal Vault |
| \`OV\` | Overview |
`;
    expect(parseLedgerAadScopes(md).sort()).toEqual(["OV", "PV"]);
  });

  it("ignores non-matching lines", () => {
    const md = "Some text without scope table rows";
    expect(parseLedgerAadScopes(md)).toEqual([]);
  });
});
