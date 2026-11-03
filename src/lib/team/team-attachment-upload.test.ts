import { describe, expect, it, vi } from "vitest";
import { deriveItemCekWrapKey, deriveItemEncryptionKey } from "@/lib/crypto/crypto-team";
import { unwrapCek, base64ToBytes } from "@/lib/team/team-attachment-crypto";
import { decryptBinary } from "@/lib/crypto/crypto-client";
import { buildAttachmentAAD } from "@/lib/crypto/crypto-aad";
import {
  FIXTURE_TEAM_ID as TEAM_ID,
  generateItemKey,
  makeResolver,
  makeTeamKeys,
  sealEntryV0,
} from "@/__tests__/helpers/team-key-fixtures";
import type { ItemEncryptionKeyInfo } from "@/lib/team/team-vault-core";
import { uploadTeamAttachment, type TeamAttachmentUploadDeps } from "./team-attachment-upload";

const ENTRY = "e1";
const FILE = {
  name: "note.txt",
  type: "text/plain",
  size: 5,
  arrayBuffer: async () => new TextEncoder().encode("hello").buffer as ArrayBuffer,
};

class UpgradeRequired extends Error {}

async function liveInfo(itemKeyVersion: number, itemKeyId: string) {
  const raw = generateItemKey();
  const info: ItemEncryptionKeyInfo = {
    keys: { encryptionKey: await deriveItemEncryptionKey(raw), cekWrapKey: await deriveItemCekWrapKey(raw) },
    itemKeyVersion,
    itemKeyId,
    teamKeyVersion: 2,
  };
  return info;
}

function formOf(call: unknown[]): FormData {
  return (call[1] as RequestInit).body as FormData;
}

describe("uploadTeamAttachment", () => {
  it("uploads mode 2: a CEK wrapped under the live ItemKey at its version, naming the ItemKey and the client attachment id", async () => {
    const info = await liveInfo(3, "ik-1");
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    const deps: TeamAttachmentUploadDeps = {
      teamId: TEAM_ID, entryId: ENTRY, fetchApi: fetch,
      getItemEncryptionKey: async () => info,
      isUpgradeRequired: () => false,
      resolveKey: makeResolver(new Map()),
      currentTeamKeyVersion: async () => 2,
    };

    const res = await uploadTeamAttachment(deps, FILE);

    expect(res.status).toBe(201);
    const form = formOf(fetch.mock.calls[0]);
    expect(form.get("encryptionMode")).toBe("2");
    expect(form.get("itemKeyId")).toBe("ik-1");
    expect(form.get("cekKeyVersion")).toBe("3");
    const id = String(form.get("id"));
    const cek = await unwrapCek(
      { ciphertext: base64ToBytes(String(form.get("cekEncrypted"))), iv: String(form.get("cekIv")), authTag: String(form.get("cekAuthTag")) },
      info.keys.cekWrapKey,
      { teamId: TEAM_ID, entryId: ENTRY, attachmentId: id, itemKeyVersion: 3, cekWrapAadVersion: 1 },
    );
    const body = new Uint8Array(await (form.get("file") as Blob).arrayBuffer());
    const plain = await decryptBinary(
      { ciphertext: body, iv: String(form.get("iv")), authTag: String(form.get("authTag")) },
      cek as CryptoKey,
      buildAttachmentAAD(ENTRY, id),
    );
    expect(new TextDecoder().decode(plain)).toBe("hello");
  });

  it.each(["ITEM_KEY_CHANGED", "CEK_KEY_VERSION_MISMATCH"])("%s → re-reads the keys and retries once", async (code) => {
    const first = await liveInfo(1, "ik-old");
    const second = await liveInfo(2, "ik-new");
    const getItemEncryptionKey = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: code }), { status: 409 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));

    const res = await uploadTeamAttachment({
      teamId: TEAM_ID, entryId: ENTRY, fetchApi: fetch, getItemEncryptionKey,
      isUpgradeRequired: () => false, resolveKey: makeResolver(new Map()), currentTeamKeyVersion: async () => 2,
    }, FILE);

    expect(res.status).toBe(201);
    expect(formOf(fetch.mock.calls[1]).get("itemKeyId")).toBe("ik-new");
  });

  it("retries only once", async () => {
    const info = await liveInfo(1, "ik");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "ITEM_KEY_CHANGED" }), { status: 409 }));

    const res = await uploadTeamAttachment({
      teamId: TEAM_ID, entryId: ENTRY, fetchApi: fetch, getItemEncryptionKey: async () => info,
      isUpgradeRequired: () => false, resolveKey: makeResolver(new Map()), currentTeamKeyVersion: async () => 2,
    }, FILE);

    expect(res.status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("upgrades a v0 entry first (PUT at the server's nextItemKeyVersion with snapshotBlobIv), then uploads", async () => {
    const keys = await makeTeamKeys([1, 2]);
    const v0 = await sealEntryV0({ entryId: ENTRY, teamKey: keys.get(1)!, teamKeyVersion: 1, blob: "b", overview: "o" });
    const info = await liveInfo(5, "ik-up");
    const getItemEncryptionKey = vi.fn().mockRejectedValueOnce(new UpgradeRequired()).mockResolvedValueOnce(info);
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (!init) return new Response(JSON.stringify({ ...v0, nextItemKeyVersion: 5 }), { status: 200 });
      return new Response("{}", { status: init.method === "PUT" ? 200 : 201 });
    });

    const res = await uploadTeamAttachment({
      teamId: TEAM_ID, entryId: ENTRY, fetchApi: fetch, getItemEncryptionKey,
      isUpgradeRequired: (e) => e instanceof UpgradeRequired,
      resolveKey: makeResolver(keys), currentTeamKeyVersion: async () => 2,
    }, FILE);

    expect(res.status).toBe(201);
    const put = fetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toMatchObject({
      itemKeyVersion: 5,
      teamKeyVersion: 2,
      snapshotBlobIv: v0.blobIv,
    });
    const methods = fetch.mock.calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? "GET");
    expect(methods).toEqual(["GET", "PUT", "POST"]);
  });
});
