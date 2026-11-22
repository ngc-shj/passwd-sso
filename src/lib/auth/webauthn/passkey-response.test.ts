import { describe, it, expect } from "vitest";
import { readPasskeyOptions, readPrfData } from "./passkey-response";

describe("readPasskeyOptions", () => {
  it("returns the options, challenge id and salt from a well-formed body", () => {
    expect(
      readPasskeyOptions({ options: { rpId: "x" }, challengeId: "ch-1", prfSalt: "ab" }),
    ).toEqual({ options: { rpId: "x" }, challengeId: "ch-1", prfSalt: "ab" });
  });

  it.each([
    ["an empty", { options: {}, challengeId: "ch-1", prfSalt: "" }],
    ["a null", { options: {}, challengeId: "ch-1", prfSalt: null }],
    ["a missing", { options: {}, challengeId: "ch-1" }],
  ])("accepts the options with %s salt, leaving the salt undefined", (_label, body) => {
    const read = readPasskeyOptions(body);
    expect(read?.challengeId).toBe("ch-1");
    expect(read?.prfSalt).toBeUndefined();
  });

  it.each([
    ["an unreadable body", null],
    ["missing options", { challengeId: "ch-1" }],
    ["array options", { options: [], challengeId: "ch-1" }],
    ["a missing challenge id", { options: {} }],
    ["an empty challenge id", { options: {}, challengeId: "" }],
  ])("returns null for %s", (_label, body) => {
    expect(readPasskeyOptions(body)).toBeNull();
  });
});

describe("readPrfData", () => {
  const prf = { prfEncryptedSecretKey: "ct", prfSecretKeyIv: "iv", prfSecretKeyAuthTag: "tag" };

  it("returns the PRF bundle from a verify body", () => {
    expect(readPrfData({ ok: true, prf })).toEqual(prf);
  });

  it.each([
    ["an unreadable body", null],
    ["no prf", { ok: true }],
    ["a null prf", { ok: true, prf: null }],
    ["a field of the wrong type", { prf: { ...prf, prfSecretKeyIv: 1 } }],
    ["a missing field", { prf: { prfEncryptedSecretKey: "ct", prfSecretKeyIv: "iv" } }],
  ])("returns null for %s", (_label, body) => {
    expect(readPrfData(body)).toBeNull();
  });
});
