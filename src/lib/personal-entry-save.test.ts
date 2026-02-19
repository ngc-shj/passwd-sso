import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATH, ENTRY_TYPE, apiPath } from "@/lib/constants";
import { savePersonalEntry } from "@/lib/personal-entry-save";

vi.mock("@/lib/crypto-client", () => ({
  encryptData: vi.fn(async (value: string) => `enc:${value}`),
}));

describe("savePersonalEntry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates personal entry via POST with generated id", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const uuidMock = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("entry-new");

    await savePersonalEntry({
      mode: "create",
      encryptionKey: {} as CryptoKey,
      userId: "user-1",
      fullBlob: "{\"a\":1}",
      overviewBlob: "{\"b\":2}",
      tagIds: ["tag-a"],
      entryType: ENTRY_TYPE.SECURE_NOTE,
      folderId: "folder-1",
      requireReprompt: true,
    });

    expect(uuidMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(API_PATH.PASSWORDS);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.id).toBe("entry-new");
    expect(body.entryType).toBe(ENTRY_TYPE.SECURE_NOTE);
    expect(body.folderId).toBe("folder-1");
    expect(body.requireReprompt).toBe(true);
    expect(body.tagIds).toEqual(["tag-a"]);
    expect(body.encryptedBlob).toBe("enc:{\"a\":1}");
    expect(body.encryptedOverview).toBe("enc:{\"b\":2}");
    expect(body.aadVersion).toBeGreaterThan(0);
  });

  it("updates personal entry via PUT without create-only fields", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await savePersonalEntry({
      mode: "edit",
      initialId: "entry-existing",
      encryptionKey: {} as CryptoKey,
      fullBlob: "{}",
      overviewBlob: "{}",
      tagIds: [],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(apiPath.passwordById("entry-existing"));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.id).toBeUndefined();
    expect(body.aadVersion).toBe(0);
    expect(body.entryType).toBeUndefined();
    expect(body.folderId).toBeUndefined();
    expect(body.requireReprompt).toBeUndefined();
  });

  it("throws when edit mode has no initialId", async () => {
    await expect(
      savePersonalEntry({
        mode: "edit",
        encryptionKey: {} as CryptoKey,
        fullBlob: "{}",
        overviewBlob: "{}",
        tagIds: [],
      }),
    ).rejects.toThrow("initialId is required for edit mode");
  });
});
