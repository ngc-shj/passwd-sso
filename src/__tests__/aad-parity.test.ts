import { describe, it, expect } from "vitest";
import {
  buildPersonalEntryAAD as appBuildPersonalEntryAAD,
  VAULT_TYPE as APP_VAULT_TYPE,
} from "@/lib/crypto/crypto-aad";
import { encryptData } from "@/lib/crypto/crypto-client";
import {
  buildPersonalEntryAAD as extBuildPersonalEntryAAD,
  VAULT_TYPE as EXT_VAULT_TYPE,
  decryptData as extDecryptData,
} from "../../extension/src/lib/crypto";

// Recurrence guard for the desync fixed in fix/ext-personal-aad-3field-sync:
// the app moved the personal-vault AAD to a 3-field shape (#482) and the
// extension was not updated, silently breaking decryption. This test fails
// the moment the app personal AAD diverges from the extension's. The frozen
// golden vectors additionally pin the absolute shape so a change that breaks
// BOTH sides identically still fails. (iOS pins the same vectors in
// ios/PasswdSSOTests/AADParityTests.swift; team/history AADs are out of scope.)

const toHex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

// "PV"(5056) + version 01 + nFields 03 + len(1)"u" + len(1)"e" + len(N)vaultType
const GOLDEN_BLOB = "505601030001750001650004626c6f62";
const GOLDEN_OVERVIEW = "5056010300017500016500086f76657276696577";

describe("personal-vault AAD parity (app ↔ extension)", () => {
  const userId = "u";
  const entryId = "e";

  it("produces identical BLOB AAD bytes across app and extension", () => {
    expect(toHex(extBuildPersonalEntryAAD(userId, entryId, EXT_VAULT_TYPE.BLOB))).toBe(
      toHex(appBuildPersonalEntryAAD(userId, entryId, APP_VAULT_TYPE.BLOB)),
    );
  });

  it("produces identical OVERVIEW AAD bytes across app and extension", () => {
    expect(toHex(extBuildPersonalEntryAAD(userId, entryId, EXT_VAULT_TYPE.OVERVIEW))).toBe(
      toHex(appBuildPersonalEntryAAD(userId, entryId, APP_VAULT_TYPE.OVERVIEW)),
    );
  });

  it("matches the frozen 3-field golden vectors (both implementations)", () => {
    expect(toHex(appBuildPersonalEntryAAD(userId, entryId, APP_VAULT_TYPE.BLOB))).toBe(GOLDEN_BLOB);
    expect(toHex(extBuildPersonalEntryAAD(userId, entryId, EXT_VAULT_TYPE.BLOB))).toBe(GOLDEN_BLOB);
    expect(toHex(appBuildPersonalEntryAAD(userId, entryId, APP_VAULT_TYPE.OVERVIEW))).toBe(
      GOLDEN_OVERVIEW,
    );
    expect(toHex(extBuildPersonalEntryAAD(userId, entryId, EXT_VAULT_TYPE.OVERVIEW))).toBe(
      GOLDEN_OVERVIEW,
    );
  });

  it("uses the 3-field shape (nFields byte = 3), differing from the legacy 2-field AAD", () => {
    expect(extBuildPersonalEntryAAD(userId, entryId, EXT_VAULT_TYPE.BLOB)[3]).toBe(3);
  });

  it("produces identical bytes for non-ASCII (UTF-8) identifiers", () => {
    const u = "ユーザー";
    const e = "エントリ";
    expect(toHex(extBuildPersonalEntryAAD(u, e, EXT_VAULT_TYPE.OVERVIEW))).toBe(
      toHex(appBuildPersonalEntryAAD(u, e, APP_VAULT_TYPE.OVERVIEW)),
    );
  });

  it("cross-decrypt: app-encrypted overview decrypts in the extension with the matching OVERVIEW AAD", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const payload = JSON.stringify({ title: "t", username: "user", urlHost: "example.com" });
    const enc = await encryptData(
      payload,
      key,
      appBuildPersonalEntryAAD(userId, entryId, APP_VAULT_TYPE.OVERVIEW),
    );
    const dec = await extDecryptData(
      enc,
      key,
      extBuildPersonalEntryAAD(userId, entryId, EXT_VAULT_TYPE.OVERVIEW),
    );
    expect(dec).toBe(payload);
  });

  it("anti-vacuous: a BLOB-encrypted field fails to decrypt with the OVERVIEW AAD", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const enc = await encryptData(
      "secret",
      key,
      appBuildPersonalEntryAAD(userId, entryId, APP_VAULT_TYPE.BLOB),
    );
    await expect(
      extDecryptData(enc, key, extBuildPersonalEntryAAD(userId, entryId, EXT_VAULT_TYPE.OVERVIEW)),
    ).rejects.toThrow();
  });
});
