import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAttachmentAAD,
  buildItemKeyWrapAAD,
  buildTeamAttachmentCekWrapAAD,
  buildTeamEntryAAD,
} from "@/lib/crypto/crypto-aad";
import {
  deriveItemCekWrapKey,
  deriveItemEncryptionKey,
  deriveTeamEncryptionKey,
  unwrapItemKey,
  unwrapTeamAttachmentCek,
  type TeamAttachmentCekWrapContext,
} from "@/lib/crypto/crypto-team";
import { decryptBinary, decryptData, hexDecode, hexEncode, toArrayBuffer } from "@/lib/crypto/crypto-client";

// The cross-codebase team-key fixture (scripts/generate-team-key-fixture.ts,
// captured from the extension) decrypted by the app's own crypto: the re-keyed
// itemKeyVersion 2 entry and a mode-2 team attachment whose CEK is wrapped
// under the entry ItemKey ("TW"). The extension and iOS decrypt the same file.
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "ios/PasswdSSOTests/fixtures/team-key-fixture.json"), "utf8"),
);

async function itemKeyV2(): Promise<Uint8Array> {
  const teamEncKey = await deriveTeamEncryptionKey(hexDecode(fixture.rawTeamKeyHex));
  return unwrapItemKey(
    fixture.encryptedItemKeyV2,
    teamEncKey,
    buildItemKeyWrapAAD(fixture.teamId, fixture.entryIdV2, fixture.teamKeyVersion),
  );
}

const twCtx = (itemKeyVersion: number): TeamAttachmentCekWrapContext => ({
  teamId: fixture.teamId,
  entryId: fixture.entryIdV2,
  attachmentId: fixture.attachmentId,
  itemKeyVersion,
  cekWrapAadVersion: fixture.cekWrapAadVersion,
});

const binary = (enc: { ciphertext: string; iv: string; authTag: string }) => ({
  ciphertext: hexDecode(enc.ciphertext),
  iv: enc.iv,
  authTag: enc.authTag,
});

describe("team-key fixture: itemKeyVersion 2 entry", () => {
  it("builds the fixture's IK and OV AAD bytes", () => {
    expect(hexEncode(buildItemKeyWrapAAD(fixture.teamId, fixture.entryIdV2, fixture.teamKeyVersion))).toBe(
      fixture.itemKeyWrapAADV2Hex,
    );
    expect(
      hexEncode(buildTeamEntryAAD(fixture.teamId, fixture.entryIdV2, "overview", fixture.itemKeyVersionV2)),
    ).toBe(fixture.overviewAADV2Hex);
  });

  it("decrypts the overview under the itemKeyVersion 2 AAD", async () => {
    const itemKey = await itemKeyV2();
    expect(hexEncode(itemKey)).toBe(fixture.itemKeyV2Hex);
    const plain = await decryptData(
      fixture.encryptedOverviewV2,
      await deriveItemEncryptionKey(itemKey),
      buildTeamEntryAAD(fixture.teamId, fixture.entryIdV2, "overview", fixture.itemKeyVersionV2),
    );
    expect(plain).toBe(fixture.overviewPlaintextV2);
  });

  it("rejects the same ciphertext under the itemKeyVersion 1 AAD", async () => {
    const key = await deriveItemEncryptionKey(await itemKeyV2());
    await expect(
      decryptData(
        fixture.encryptedOverviewV2,
        key,
        buildTeamEntryAAD(fixture.teamId, fixture.entryIdV2, "overview", 1),
      ),
    ).rejects.toThrow();
  });
});

describe("team-key fixture: team attachment CEK wrap (TW)", () => {
  it("builds the fixture's TW and AT AAD bytes", () => {
    expect(
      hexEncode(
        buildTeamAttachmentCekWrapAAD(
          fixture.teamId,
          fixture.entryIdV2,
          fixture.attachmentId,
          fixture.itemKeyVersionV2,
          fixture.cekWrapAadVersion,
        ),
      ),
    ).toBe(fixture.cekWrapAADHex);
    expect(hexEncode(buildAttachmentAAD(fixture.entryIdV2, fixture.attachmentId))).toBe(
      fixture.attachmentAADHex,
    );
  });

  it("unwraps the CEK and decrypts the attachment body", async () => {
    const cek = await unwrapTeamAttachmentCek(
      binary(fixture.encryptedCek),
      await deriveItemCekWrapKey(await itemKeyV2()),
      twCtx(fixture.itemKeyVersionV2),
    );
    expect(hexEncode(cek)).toBe(fixture.cekHex);
    const cekKey = await crypto.subtle.importKey("raw", toArrayBuffer(cek), { name: "AES-GCM" }, false, ["decrypt"]);
    const body = await decryptBinary(
      binary(fixture.encryptedAttachmentBody),
      cekKey,
      buildAttachmentAAD(fixture.entryIdV2, fixture.attachmentId),
    );
    expect(new TextDecoder().decode(body)).toBe(fixture.attachmentBodyPlaintext);
  });

  it("rejects the wrapped CEK under the itemKeyVersion 1 AAD", async () => {
    await expect(
      unwrapTeamAttachmentCek(
        binary(fixture.encryptedCek),
        await deriveItemCekWrapKey(await itemKeyV2()),
        twCtx(1),
      ),
    ).rejects.toThrow();
  });
});
