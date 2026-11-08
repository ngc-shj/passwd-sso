import { describe, it, expect } from "vitest";
import {
  buildPersonalEntryAAD as appBuildPersonalEntryAAD,
  buildTeamEntryAAD as appBuildTeamEntryAAD,
  buildItemKeyWrapAAD as appBuildItemKeyWrapAAD,
  buildAttachmentAAD as appBuildAttachmentAAD,
  buildTeamAttachmentCekWrapAAD as appBuildTeamAttachmentCekWrapAAD,
  VAULT_TYPE as APP_VAULT_TYPE,
} from "@/lib/crypto/crypto-aad";
import {
  buildTeamKeyWrapAAD as appBuildTeamKeyWrapAAD,
  openTeamEntryField as appOpenTeamEntryField,
  sealTeamEntryField as appSealTeamEntryField,
  type TeamEntryAadContext,
} from "@/lib/crypto/crypto-team";
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
  buildTeamAttachmentCekWrapAAD as extBuildTeamAttachmentCekWrapAAD,
  openTeamEntryField as extOpenTeamEntryField,
} from "../../extension/src/lib/crypto-team";

// Recurrence guard for the cross-codebase AAD desync class (#503: the app
// moved the personal-vault AAD to a 3-field shape and the extension lagged,
// silently breaking decryption). Each scope shared between app and extension
// is pinned here: app and extension MUST emit byte-identical AAD, and a frozen
// golden vector additionally catches a change that breaks BOTH sides
// identically. Covers PV (personal) + OV/IK/OK/TW (team). (iOS pins the same
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

describe("team attachment CEK wrap AAD parity (app ↔ extension; iOS shares the scope)", () => {
  // TW is implemented by the app, the extension and iOS. The frozen golden
  // vector locks the byte shape; iOS pins the same bytes in AADParityTests.swift.
  const GOLDEN_TW = "54570105000174000165000161000132000131";

  it("TW (team attachment CEK wrap) AAD: app === extension === golden", () => {
    expect(toHex(appBuildTeamAttachmentCekWrapAAD("t", "e", "a", 2, 1))).toBe(GOLDEN_TW);
    expect(toHex(extBuildTeamAttachmentCekWrapAAD("t", "e", "a", 2, 1))).toBe(GOLDEN_TW);
  });

  it("produces identical bytes for non-ASCII (UTF-8) identifiers", () => {
    expect(toHex(extBuildTeamAttachmentCekWrapAAD("チーム", "エントリ", "添付", 3, 1))).toBe(
      toHex(appBuildTeamAttachmentCekWrapAAD("チーム", "エントリ", "添付", 3, 1)),
    );
  });
});

describe("team entry golden ciphertext at itemKeyVersion 2 (app helper ↔ extension twin; iOS mirrors)", () => {
  // A fixed key / IV ciphertext per field, sealed at the team entry AAD at
  // itemKeyVersion 2 by an independent AES-GCM implementation. Both the app's
  // openTeamEntryField and the extension twin must open it, and neither may
  // when any single context field differs. iOS pins the same vectors in
  // AADParityTests.swift (testTeamEntryGoldenCiphertextItemKeyVersion2).
  const KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  const GOLDEN = {
    blob: {
      aadHex: "4f5601040001740001650004626c6f62000132",
      enc: { ciphertext: "149f4ea11fb1b2578c26bf62b2c88026df32fd5fde198dc3842bafb46b7facc154", iv: "0a0b0c0d0e0f101112131415", authTag: "5b988622130061a798910620926ca826" },
      plaintext: '{"title":"golden","password":"p"}',
    },
    overview: {
      aadHex: "4f56010400017400016500086f76657276696577000132",
      enc: { ciphertext: "edde55fdb54dd5f8783a9e1e77d16b330d4d", iv: "1a1b1c1d1e1f202122232425", authTag: "207483b8e1a7a43fa475366bc2e27be0" },
      plaintext: '{"title":"golden"}',
    },
  } as const;
  const ctxOf = (vaultType: "blob" | "overview"): TeamEntryAadContext => ({ teamId: "t", entryId: "e", vaultType, itemKeyVersion: 2 });
  const importKey = () => crypto.subtle.importKey(
    "raw", new Uint8Array(Buffer.from(KEY_HEX, "hex")), "AES-GCM", false, ["encrypt", "decrypt"],
  );

  it.each(["blob", "overview"] as const)("%s AAD at itemKeyVersion 2: app === extension === golden", (vaultType) => {
    expect(toHex(appBuildTeamEntryAAD("t", "e", vaultType, 2))).toBe(GOLDEN[vaultType].aadHex);
    expect(toHex(extBuildTeamEntryAAD("t", "e", vaultType, 2))).toBe(GOLDEN[vaultType].aadHex);
  });

  it.each(["blob", "overview"] as const)("the app helper and the extension twin open the golden %s", async (vaultType) => {
    const key = await importKey();
    const { enc, plaintext } = GOLDEN[vaultType];
    expect(await appOpenTeamEntryField(enc, key, ctxOf(vaultType))).toBe(plaintext);
    expect(await extOpenTeamEntryField(enc, key, ctxOf(vaultType))).toBe(plaintext);
  });

  it.each([
    ["teamId", { teamId: "t2" }],
    ["entryId", { entryId: "e2" }],
    ["itemKeyVersion", { itemKeyVersion: 1 }],
  ] as const)("neither opens the golden blob when only %s differs", async (_field, change) => {
    const key = await importKey();
    const ctx = { ...ctxOf("blob"), ...change };
    await expect(appOpenTeamEntryField(GOLDEN.blob.enc, key, ctx)).rejects.toThrow();
    await expect(extOpenTeamEntryField(GOLDEN.blob.enc, key, ctx)).rejects.toThrow();
  });

  it("neither opens the golden blob at the overview vaultType, nor the golden overview at blob", async () => {
    const key = await importKey();
    await expect(appOpenTeamEntryField(GOLDEN.blob.enc, key, ctxOf("overview"))).rejects.toThrow();
    await expect(extOpenTeamEntryField(GOLDEN.blob.enc, key, ctxOf("overview"))).rejects.toThrow();
    await expect(appOpenTeamEntryField(GOLDEN.overview.enc, key, ctxOf("blob"))).rejects.toThrow();
    await expect(extOpenTeamEntryField(GOLDEN.overview.enc, key, ctxOf("blob"))).rejects.toThrow();
  });

  it("an app-sealed field opens in the extension twin at the same context only", async () => {
    const key = await importKey();
    const sealed = await appSealTeamEntryField("round-trip", key, ctxOf("overview"));
    expect(await extOpenTeamEntryField(sealed, key, ctxOf("overview"))).toBe("round-trip");
    await expect(extOpenTeamEntryField(sealed, key, { ...ctxOf("overview"), itemKeyVersion: 3 })).rejects.toThrow();
  });
});
