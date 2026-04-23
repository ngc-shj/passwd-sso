import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiPath } from "@/lib/constants";

// fetchApi has a `typeof window` guard — bypass it so node-env tests work
vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) =>
    init !== undefined ? fetch(path, init) : fetch(path),
  withBasePath: (p: string) => p,
  BASE_PATH: "",
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  encryptData: vi.fn(async (value: string) => `enc:${value}`),
}));

import { saveTeamEntry } from "@/lib/team/team-entry-save";

describe("saveTeamEntry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates team entry via POST with provided entryId", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await saveTeamEntry({
      mode: "create",
      teamId: "team-1",
      entryId: "entry-new",
      encryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      itemKeyVersion: 1,
      encryptedItemKey: { ciphertext: "cipher", iv: "iv", authTag: "tag" },
      fullBlob: "{\"a\":1}",
      overviewBlob: "{\"b\":2}",
      tagIds: ["tag-a"],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(apiPath.teamPasswords("team-1"));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.id).toBe("entry-new");
    expect(body.teamKeyVersion).toBe(1);
    expect(body.itemKeyVersion).toBe(1);
    expect(body.tagIds).toEqual(["tag-a"]);
    expect(body.encryptedBlob).toBe("enc:{\"a\":1}");
    expect(body.encryptedOverview).toBe("enc:{\"b\":2}");
    expect(body.aadVersion).toBeGreaterThan(0);
    expect(body.encryptedItemKey).toEqual({ ciphertext: "cipher", iv: "iv", authTag: "tag" });
  });

  it("updates team entry via PUT without id field", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await saveTeamEntry({
      mode: "edit",
      teamId: "team-1",
      entryId: "entry-existing",
      encryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      itemKeyVersion: 1,
      fullBlob: "{}",
      overviewBlob: "{}",
      tagIds: [],
      teamFolderId: "folder-1",
      requireReprompt: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(apiPath.teamPasswordById("team-1", "entry-existing"));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.id).toBeUndefined();
    expect(body.teamFolderId).toBe("folder-1");
    expect(body.requireReprompt).toBe(true);
    expect(body.encryptedItemKey).toBeUndefined();
  });

  it("throws when itemKeyVersion >= 1 and create mode has no encryptedItemKey", async () => {
    await expect(
      saveTeamEntry({
        mode: "create",
        teamId: "team-1",
        entryId: "entry-new",
        encryptionKey: {} as CryptoKey,
        teamKeyVersion: 1,
        itemKeyVersion: 1,
        fullBlob: "{}",
        overviewBlob: "{}",
        tagIds: [],
      }),
    ).rejects.toThrow("encryptedItemKey is required when itemKeyVersion >= 1");
  });

  it("allows create mode without encryptedItemKey when itemKeyVersion is 0", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await saveTeamEntry({
      mode: "create",
      teamId: "team-1",
      entryId: "entry-new",
      encryptionKey: {} as CryptoKey,
      teamKeyVersion: 1,
      itemKeyVersion: 0,
      fullBlob: "{}",
      overviewBlob: "{}",
      tagIds: [],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.itemKeyVersion).toBe(0);
  });
});
