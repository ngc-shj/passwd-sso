import { describe, it, expect } from "vitest";
import {
  buildPersonalEntryAAD as appBuildPersonalEntryAAD,
  buildTeamEntryAAD as appBuildTeamEntryAAD,
  buildItemKeyWrapAAD as appBuildItemKeyWrapAAD,
  buildAttachmentAAD as appBuildAttachmentAAD,
  VAULT_TYPE as APP_VAULT_TYPE,
} from "@/lib/crypto/crypto-aad";
import { buildTeamKeyWrapAAD as appBuildTeamKeyWrapAAD } from "@/lib/crypto/crypto-team";
import { encryptData } from "@/lib/crypto/crypto-client";
import {
  buildPersonalEntryAAD as extBuildPersonalEntryAAD,
  VAULT_TYPE as EXT_VAULT_TYPE,
  decryptData as extDecryptData,
} from "../../extension/src/lib/crypto";
import {
  buildTeamEntryAAD as extBuildTeamEntryAAD,
  buildItemKeyWrapAAD as extBuildItemKeyWrapAAD,
  buildTeamKeyWrapAAD as extBuildTeamKeyWrapAAD,
} from "../../extension/src/lib/crypto-team";

// Recurrence guard for the cross-codebase AAD desync class (#503: the app
// moved the personal-vault AAD to a 3-field shape and the extension lagged,
// silently breaking decryption). Each scope shared between app and extension
// is pinned here: app and extension MUST emit byte-identical AAD, and a frozen
// golden vector additionally catches a change that breaks BOTH sides
// identically. Covers PV (personal) + OV/IK/OK (team). (iOS pins the same
// vectors in ios/PasswdSSOTests/AADParityTests.swift.)

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

describe("team-vault AAD parity (app ↔ extension)", () => {
  const teamId = "t";
  const entryId = "e";

  // Frozen golden vectors (generated from the builders; pin the absolute shape
  // so a both-sides-identical change still fails).
  const GOLDEN_OV_BLOB = "4f5601040001740001650004626c6f62000130";
  const GOLDEN_OV_OVERVIEW = "4f56010400017400016500086f76657276696577000130";
  const GOLDEN_IK = "494b0103000174000165000133";
  const GOLDEN_OK = "4f4b0104000174000175000132000131";

  it("OV (team entry) blob+overview AAD: app === extension === golden", () => {
    expect(toHex(appBuildTeamEntryAAD(teamId, entryId, "blob", 0))).toBe(GOLDEN_OV_BLOB);
    expect(toHex(extBuildTeamEntryAAD(teamId, entryId, "blob", 0))).toBe(GOLDEN_OV_BLOB);
    expect(toHex(appBuildTeamEntryAAD(teamId, entryId, "overview", 0))).toBe(GOLDEN_OV_OVERVIEW);
    expect(toHex(extBuildTeamEntryAAD(teamId, entryId, "overview", 0))).toBe(GOLDEN_OV_OVERVIEW);
  });

  it("IK (item key wrap) AAD: app === extension === golden", () => {
    expect(toHex(appBuildItemKeyWrapAAD(teamId, entryId, 3))).toBe(GOLDEN_IK);
    expect(toHex(extBuildItemKeyWrapAAD(teamId, entryId, 3))).toBe(GOLDEN_IK);
  });

  it("OK (team member key wrap) AAD: app === extension === golden", () => {
    const ctx = { teamId, toUserId: "u", keyVersion: 2, wrapVersion: 1 };
    expect(toHex(appBuildTeamKeyWrapAAD(ctx))).toBe(GOLDEN_OK);
    expect(toHex(extBuildTeamKeyWrapAAD(ctx))).toBe(GOLDEN_OK);
  });

  it("anti-vacuous: OV blob AAD differs from OV overview AAD (scope/field sanity)", () => {
    expect(toHex(appBuildTeamEntryAAD(teamId, entryId, "blob", 0))).not.toBe(
      toHex(appBuildTeamEntryAAD(teamId, entryId, "overview", 0)),
    );
  });
});

describe("attachment AAD golden vector (app, iOS-shared scope)", () => {
  // AT scope is implemented by the app and iOS (no extension builder).
  // The frozen golden vector locks the byte shape across both codebases;
  // iOS CI verifies the Swift builder produces the same bytes at runtime.
  const GOLDEN_AT = "41540102000165000161";

  it("AT (attachment) AAD matches the frozen golden vector", () => {
    expect(toHex(appBuildAttachmentAAD("e", "a"))).toBe(GOLDEN_AT);
  });
});
