import { describe, it, expect } from "vitest";
import {
  InvalidArtifactKeyError,
  STATEMENT_OP,
  assertAnchorArtifactKey,
  buildManifestArtifactKey,
  isAnchorArtifactKey,
  isAnchorKid,
  parseManifestArtifactKey,
  publicKeyArtifactKey,
  statementArtifactKey,
} from "./anchor-artifact-keys";

const KID = "audit-anchor-0123456789abcdef";
const OTHER_KID = "audit-anchor-fedcba9876543210";

describe("isAnchorKid", () => {
  it("accepts the prefix followed by 16 lower-case hex chars", () => {
    expect(isAnchorKid(KID)).toBe(true);
  });

  it.each([
    ["15 hex chars", "audit-anchor-0123456789abcde"],
    ["17 hex chars", "audit-anchor-0123456789abcdef0"],
    ["upper-case hex", "audit-anchor-0123456789ABCDEF"],
    ["a non-hex char", "audit-anchor-0123456789abcdeg"],
    ["the 8-char form the old pattern admitted", "audit-anchor-abcd1234"],
    ["another prefix", "audit-anchxr-0123456789abcdef"],
    ["a path separator", "audit-anchor-01234567/9abcdef"],
    ["a trailing newline", `${KID}\n`],
    ["a non-string", 42],
    ["undefined", undefined],
  ])("refuses %s", (_label, kid) => {
    expect(isAnchorKid(kid)).toBe(false);
  });
});

describe("buildManifestArtifactKey / parseManifestArtifactKey", () => {
  it("builds YYYY-MM-DD.kid-<kid>.jws from the boundary's UTC date", () => {
    expect(buildManifestArtifactKey(new Date("2026-01-15T00:05:00Z"), KID)).toBe(`2026-01-15.kid-${KID}.jws`);
  });

  it("dates the key by UTC, not local time, at either end of the day", () => {
    expect(buildManifestArtifactKey(new Date("2026-01-15T23:59:59.999Z"), KID)).toBe(`2026-01-15.kid-${KID}.jws`);
    expect(buildManifestArtifactKey(new Date("2026-01-16T00:00:00.000Z"), KID)).toBe(`2026-01-16.kid-${KID}.jws`);
  });

  it("parses what it builds back to the date and the kid", () => {
    const key = buildManifestArtifactKey(new Date("2027-12-31T00:05:00Z"), OTHER_KID);
    expect(parseManifestArtifactKey(key)).toEqual({ date: "2027-12-31", kid: OTHER_KID });
  });

  it("refuses to build a key for a kid of another shape", () => {
    expect(() => buildManifestArtifactKey(new Date("2026-01-15T00:05:00Z"), "audit-anchor-abcd1234")).toThrow(
      InvalidArtifactKeyError,
    );
  });

  it.each([
    ["a kid of another shape", "2026-01-15.kid-audit-anchor-abc.jws"],
    ["a date that is not a calendar day", `2026-02-30.kid-${KID}.jws`],
    ["a month 13", `2026-13-01.kid-${KID}.jws`],
    ["a compact date", `20260115.kid-${KID}.jws`],
    ["another extension", `2026-01-15.kid-${KID}.json`],
    ["a directory in front", `sub/2026-01-15.kid-${KID}.jws`],
    ["a suffix", `2026-01-15.kid-${KID}.jws.bak`],
    ["a public-key key", `public-keys/${KID}.pub`],
    ["the empty string", ""],
  ])("parses %s as null", (_label, key) => {
    expect(parseManifestArtifactKey(key)).toBeNull();
  });
});

describe("publicKeyArtifactKey / statementArtifactKey", () => {
  const day = new Date("2026-01-15T10:00:00.000Z");

  it("builds public-keys/<kid>.pub", () => {
    expect(publicKeyArtifactKey(KID)).toBe(`public-keys/${KID}.pub`);
  });

  it("builds key-rotation-YYYYMMDD.<op>.kid-<signer kid>.jws for each op", () => {
    expect(statementArtifactKey(day, STATEMENT_OP.ROTATION, KID)).toBe(`key-rotation-20260115.rotation.kid-${KID}.jws`);
    expect(statementArtifactKey(day, STATEMENT_OP.CHAIN_RESTART, KID)).toBe(
      `key-rotation-20260115.chain-restart.kid-${KID}.jws`,
    );
  });

  it("gives a rotation and a chain-restart statement of one day and signer different keys", () => {
    expect(statementArtifactKey(day, STATEMENT_OP.ROTATION, KID)).not.toBe(
      statementArtifactKey(day, STATEMENT_OP.CHAIN_RESTART, KID),
    );
  });

  it("refuses a kid of another shape", () => {
    expect(() => publicKeyArtifactKey("../escape")).toThrow(InvalidArtifactKeyError);
    expect(() => statementArtifactKey(day, STATEMENT_OP.ROTATION, "audit-anchor-abcd1234")).toThrow(
      InvalidArtifactKeyError,
    );
  });
});

describe("isAnchorArtifactKey / assertAnchorArtifactKey", () => {
  const day = new Date("2026-01-15T10:00:00.000Z");
  const known = [
    buildManifestArtifactKey(day, KID),
    publicKeyArtifactKey(KID),
    statementArtifactKey(day, STATEMENT_OP.ROTATION, KID),
    statementArtifactKey(day, STATEMENT_OP.CHAIN_RESTART, KID),
  ];

  it.each(known)("accepts %s", (key) => {
    expect(isAnchorArtifactKey(key)).toBe(true);
    expect(() => assertAnchorArtifactKey(key)).not.toThrow();
  });

  it.each([
    ["a bare name", "notes.txt"],
    ["the runbook's old advisory name", "key-rotation-2026-01-15.json"],
    ["a statement of an unknown op", `key-rotation-20260115.revocation.kid-${KID}.jws`],
    ["a statement dated on no calendar day", `key-rotation-20260230.rotation.kid-${KID}.jws`],
    ["a statement without the op", `key-rotation-20260115.kid-${KID}.jws`],
    ["a public key with another extension", `public-keys/${KID}.pem`],
    ["a public key under a deeper directory", `public-keys/old/${KID}.pub`],
    ["a manifest under public-keys/", `public-keys/2026-01-15.kid-${KID}.jws`],
    ["a path that climbs out", `../2026-01-15.kid-${KID}.jws`],
    ["an absolute path", `/2026-01-15.kid-${KID}.jws`],
    ["a manifest key with a trailing newline", `2026-01-15.kid-${KID}.jws\n`],
  ])("refuses %s", (_label, key) => {
    expect(isAnchorArtifactKey(key)).toBe(false);
    expect(() => assertAnchorArtifactKey(key)).toThrow(InvalidArtifactKeyError);
  });

  it("carries a token code and no key text in the error", () => {
    const error = (() => {
      try {
        assertAnchorArtifactKey("secret/path.txt");
      } catch (err) {
        return err as InvalidArtifactKeyError;
      }
    })();
    expect(error?.code).toBe("INVALID_ARTIFACT_KEY");
    expect(error?.message).not.toContain("secret/path.txt");
  });
});
