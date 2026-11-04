import { describe, expect, it } from "vitest";
import { encryptBinary } from "@/lib/crypto/crypto-client";
import { deriveItemCekWrapKey, deriveItemEncryptionKey } from "@/lib/crypto/crypto-team";
import { buildAttachmentAAD } from "@/lib/crypto/crypto-aad";
import {
  FIXTURE_TEAM_ID as TEAM_ID,
  generateItemKey,
  makeResolver,
  makeTeamKey,
  makeTeamKeys,
  wrapUnder,
} from "@/__tests__/helpers/team-key-fixtures";
import {
  ATTACHMENT_KEY_FAILURE,
  TeamAttachmentKeyError,
  bytesToBase64,
  decryptTeamAttachmentDownload,
  encryptTeamAttachmentMode2,
  sha256Hex,
  type TeamAttachmentDownload,
} from "./team-attachment-crypto";

const ENTRY = "e1";
const ATT = "a1";
const BODY = new TextEncoder().encode("attachment body");

function download(fields: Partial<TeamAttachmentDownload>): TeamAttachmentDownload {
  return {
    id: ATT,
    filename: "f.txt",
    contentType: "text/plain",
    sizeBytes: BODY.length,
    encryptedData: "",
    iv: "",
    authTag: "",
    aadVersion: 1,
    encryptionMode: 2,
    keyVersion: 2,
    ...fields,
  };
}

async function sealBody(key: CryptoKey) {
  const sealed = await encryptBinary(BODY.slice().buffer as ArrayBuffer, key, buildAttachmentAAD(ENTRY, ATT));
  return { encryptedData: bytesToBase64(sealed.ciphertext), iv: sealed.iv, authTag: sealed.authTag };
}

const text = (buf: ArrayBuffer) => new TextDecoder().decode(buf);

describe("decryptTeamAttachmentDownload", () => {
  it("mode 2: opens the CEK through the served wrap and the body with the CEK", async () => {
    const keys = await makeTeamKeys([2]);
    const itemKey = generateItemKey();
    const sealed = await encryptTeamAttachmentMode2(BODY.slice().buffer as ArrayBuffer, {
      teamId: TEAM_ID, entryId: ENTRY, attachmentId: ATT, itemKeyVersion: 3,
      cekWrapKey: await deriveItemCekWrapKey(itemKey),
    });
    const data = download({
      encryptedData: bytesToBase64(sealed.body.ciphertext),
      iv: sealed.body.iv,
      authTag: sealed.body.authTag,
      cekEncrypted: sealed.cekEncrypted,
      cekIv: sealed.cekIv,
      cekAuthTag: sealed.cekAuthTag,
      cekKeyVersion: 3,
      cekWrapAadVersion: sealed.cekWrapAadVersion,
      itemKeyWrap: { ...(await wrapUnder(itemKey, keys.get(2)!, ENTRY, 2)), teamKeyVersion: 2, itemKeyVersion: 3 },
    });

    expect(text(await decryptTeamAttachmentDownload(TEAM_ID, ENTRY, data, makeResolver(keys)))).toBe("attachment body");
  });

  it("mode 2 bound to no ItemKey id: tries the served wraps in turn until one opens the CEK (here the second)", async () => {
    const keys = await makeTeamKeys([1, 2]);
    const liveKey = generateItemKey();
    const historyKey = generateItemKey();
    const sealed = await encryptTeamAttachmentMode2(BODY.slice().buffer as ArrayBuffer, {
      teamId: TEAM_ID, entryId: ENTRY, attachmentId: ATT, itemKeyVersion: 1,
      cekWrapKey: await deriveItemCekWrapKey(historyKey),
    });
    const base = {
      encryptedData: bytesToBase64(sealed.body.ciphertext),
      iv: sealed.body.iv,
      authTag: sealed.body.authTag,
      cekEncrypted: sealed.cekEncrypted,
      cekIv: sealed.cekIv,
      cekAuthTag: sealed.cekAuthTag,
      cekKeyVersion: 1,
      cekWrapAadVersion: sealed.cekWrapAadVersion,
    };
    const liveWrap = { ...(await wrapUnder(liveKey, keys.get(2)!, ENTRY, 2)), teamKeyVersion: 2, itemKeyVersion: 2 };
    const historyWrap = { ...(await wrapUnder(historyKey, keys.get(1)!, ENTRY, 1)), teamKeyVersion: 1, itemKeyVersion: 1 };

    const data = download({ ...base, itemKeyWraps: [liveWrap, historyWrap] });
    expect(text(await decryptTeamAttachmentDownload(TEAM_ID, ENTRY, data, makeResolver(keys)))).toBe("attachment body");

    // Without the wrap that holds the CEK's ItemKey nothing opens.
    await expect(
      decryptTeamAttachmentDownload(TEAM_ID, ENTRY, download({ ...base, itemKeyWraps: [liveWrap] }), makeResolver(keys)),
    ).rejects.toMatchObject({ reason: ATTACHMENT_KEY_FAILURE.UNOPENABLE });
  });

  it("mode 1: finds the ItemKey by trial over the served wraps (a history wrap)", async () => {
    const keys = await makeTeamKeys([1, 2]);
    const liveKey = generateItemKey();
    const historyKey = generateItemKey();
    const data = download({
      encryptionMode: 1,
      ...(await sealBody(await deriveItemEncryptionKey(historyKey))),
      itemKeyWraps: [
        { ...(await wrapUnder(liveKey, keys.get(2)!, ENTRY, 2)), teamKeyVersion: 2, itemKeyVersion: 2 },
        { ...(await wrapUnder(historyKey, keys.get(1)!, ENTRY, 1)), teamKeyVersion: 1, itemKeyVersion: 1 },
      ],
    });

    expect(text(await decryptTeamAttachmentDownload(TEAM_ID, ENTRY, data, makeResolver(keys)))).toBe("attachment body");
  });

  it("mode 0: opens with the team key at keyVersion, not the latest", async () => {
    const keys = await makeTeamKeys([1, 3]);
    const data = download({ encryptionMode: 0, keyVersion: 1, ...(await sealBody(keys.get(1)!)) });
    const resolve = makeResolver(keys);

    expect(text(await decryptTeamAttachmentDownload(TEAM_ID, ENTRY, data, resolve))).toBe("attachment body");
    expect(resolve.calls).toEqual([1]);
  });

  it("reports unopenable when no key the member holds opens it", async () => {
    const keys = await makeTeamKeys([1]);
    const data = download({ encryptionMode: 0, keyVersion: 1, ...(await sealBody(await makeTeamKey())) });

    await expect(decryptTeamAttachmentDownload(TEAM_ID, ENTRY, data, makeResolver(keys))).rejects.toMatchObject({
      reason: ATTACHMENT_KEY_FAILURE.UNOPENABLE,
    });
  });

  it("reports a transient key failure as transient, not unopenable", async () => {
    const keys = await makeTeamKeys([1]);
    const data = download({ encryptionMode: 0, keyVersion: 1, ...(await sealBody(keys.get(1)!)) });

    const error = await decryptTeamAttachmentDownload(TEAM_ID, ENTRY, data, makeResolver(keys, { 1: "transient" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamAttachmentKeyError);
    expect((error as TeamAttachmentKeyError).reason).toBe(ATTACHMENT_KEY_FAILURE.TRANSIENT);
  });
});

describe("sha256Hex", () => {
  it("returns the lowercase hex SHA-256 the migrate route compares clientHash with", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
