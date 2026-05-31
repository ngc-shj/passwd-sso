import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractHkdfInfoStrings,
  extractAadScopes,
  parseLedgerHkdfInfo,
  parseLedgerAadScopes,
  checkAadEncoderContainment,
  checkAeadAadAllowlist,
  checkScopeManifest,
} from "../checks/check-crypto-domains.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repository root (scripts/__tests__ → scripts → root)
const ROOT = join(__dirname, "..", "..");

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

// ── Check A: AAD encoder containment ─────────────────────────────────────────

describe("checkAadEncoderContainment", () => {
  it("flags buildAADBytes( in a non-allowlisted file", () => {
    const files = [
      {
        rel: "src/lib/some-module.ts",
        content: `
export function buildMyAAD(id: string): Uint8Array {
  return buildAADBytes("XX", 1, [id]);
}
`,
      },
    ];
    const errors = checkAadEncoderContainment(files);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/Check A/);
    expect(errors[0]).toMatch(/src\/lib\/some-module\.ts/);
  });

  it("flags the inline setUint16(<expr>, false) idiom in a non-allowlisted file", () => {
    const files = [
      {
        rel: "src/lib/ad-hoc-aad.ts",
        content: `
function buildAdHocAAD(field: string): Uint8Array {
  const view = new DataView(new ArrayBuffer(10));
  view.setUint16(0, field.length, false);
  return new Uint8Array(view.buffer);
}
`,
      },
    ];
    const errors = checkAadEncoderContainment(files);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/Check A/);
  });

  it("does not flag buildAADBytes( in an allowlisted registry file", () => {
    const files = [
      {
        rel: "src/lib/crypto/crypto-aad.ts",
        content: `function buildAADBytes(scope, n, fields) { return new Uint8Array(); }`,
      },
    ];
    const errors = checkAadEncoderContainment(files);
    expect(errors).toHaveLength(0);
  });

  it("does not flag comment lines mentioning buildAADBytes", () => {
    const files = [
      {
        rel: "src/lib/some-module.ts",
        content: `
// buildAADBytes is the private encoder in crypto-aad.ts
* buildAADBytes — not called here
`,
      },
    ];
    const errors = checkAadEncoderContainment(files);
    expect(errors).toHaveLength(0);
  });
});

// ── Check B: AEAD-with-AAD allowlist ─────────────────────────────────────────

describe("checkAeadAadAllowlist", () => {
  it("flags additionalData in a non-allowlisted file", () => {
    const files = [
      {
        rel: "src/lib/vault/some-vault-util.ts",
        content: `
const params = { name: "AES-GCM", iv, additionalData: aadBytes };
const ct = await crypto.subtle.encrypt(params, key, plaintext);
`,
      },
    ];
    const errors = checkAeadAadAllowlist(files);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/Check B/);
    expect(errors[0]).toMatch(/src\/lib\/vault\/some-vault-util\.ts/);
  });

  it("flags .setAAD( in a non-allowlisted file", () => {
    const files = [
      {
        rel: "src/lib/some-server-crypto.ts",
        content: `
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
cipher.setAAD(aadBytes);
`,
      },
    ];
    const errors = checkAeadAadAllowlist(files);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/Check B/);
  });

  it("does not flag additionalData in an allowlisted primitive file", () => {
    const files = [
      {
        rel: "src/lib/crypto/crypto-client.ts",
        content: `params.additionalData = toArrayBuffer(aad);`,
      },
    ];
    const errors = checkAeadAadAllowlist(files);
    expect(errors).toHaveLength(0);
  });

  it("does not flag .setAAD( in an allowlisted primitive file", () => {
    const files = [
      {
        rel: "src/lib/crypto/envelope.ts",
        content: `cipher.setAAD(aad);`,
      },
    ];
    const errors = checkAeadAadAllowlist(files);
    expect(errors).toHaveLength(0);
  });

  it("does not flag comment lines mentioning additionalData or setAAD", () => {
    const files = [
      {
        rel: "src/lib/some-module.ts",
        content: `
// additionalData is set in crypto-client.ts only
// cipher.setAAD(aad) is called inside envelope.ts
`,
      },
    ];
    const errors = checkAeadAadAllowlist(files);
    expect(errors).toHaveLength(0);
  });
});

// ── Check C: per-scope manifest coverage ─────────────────────────────────────

describe("checkScopeManifest", () => {
  it("flags a code scope missing from the manifest", () => {
    const codeScopes = new Set(["PV", "OV", "NEW"]);
    const manifest = {
      PV: { crossCodebase: false, roundTrip: "src/__tests__/aad-parity.test.ts" },
      OV: { crossCodebase: false, roundTrip: "src/__tests__/aad-parity.test.ts" },
      // NEW is not here
    };
    const errors = checkScopeManifest(codeScopes, manifest, ROOT);
    expect(errors.some((e) => e.includes('"NEW"') && e.includes("no entry"))).toBe(true);
  });

  it("flags a manifest scope not present in code", () => {
    const codeScopes = new Set(["PV"]);
    const manifest = {
      PV: { crossCodebase: false, roundTrip: "src/__tests__/aad-parity.test.ts" },
      STALE: { crossCodebase: false, roundTrip: "src/__tests__/aad-parity.test.ts" },
    };
    const errors = checkScopeManifest(codeScopes, manifest, ROOT);
    expect(errors.some((e) => e.includes('"STALE"') && e.includes("stale entry"))).toBe(true);
  });

  it("flags a manifest entry whose roundTrip file does not exist", () => {
    const codeScopes = new Set(["PV"]);
    const manifest = {
      PV: {
        crossCodebase: false,
        roundTrip: "src/__tests__/nonexistent-roundtrip.test.ts",
      },
    };
    const errors = checkScopeManifest(codeScopes, manifest, ROOT);
    expect(errors.some((e) => e.includes('"PV"') && e.includes("roundTrip file not found"))).toBe(true);
  });

  it("flags a crossCodebase manifest entry whose parity file does not exist", () => {
    const codeScopes = new Set(["PV"]);
    const manifest = {
      PV: {
        crossCodebase: true,
        parity: "src/__tests__/nonexistent-parity.test.ts",
        roundTrip: "src/__tests__/aad-parity.test.ts",
      },
    };
    const errors = checkScopeManifest(codeScopes, manifest, ROOT);
    expect(errors.some((e) => e.includes('"PV"') && e.includes("parity file not found"))).toBe(true);
  });

  it("passes cleanly when all scopes are present and all files exist", () => {
    const codeScopes = new Set(["PV"]);
    const manifest = {
      // Use the real aad-parity.test.ts which exists on disk
      PV: {
        crossCodebase: true,
        parity: "src/__tests__/aad-parity.test.ts",
        roundTrip: "src/__tests__/aad-parity.test.ts",
      },
    };
    const errors = checkScopeManifest(codeScopes, manifest, ROOT);
    expect(errors).toHaveLength(0);
  });
});
