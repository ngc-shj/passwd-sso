import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto-client", () => ({
  encryptData: vi.fn(async (value: string) => `enc:${value}`),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) =>
    init !== undefined ? fetch(path, init) : fetch(path),
  withBasePath: (p: string) => p,
  BASE_PATH: "",
}));

import { buildEncryptedEntryBody, submitEntry } from "@/lib/entry-save-core";

describe("buildEncryptedEntryBody", () => {
  const baseParams = {
    encryptionKey: {} as CryptoKey,
    fullBlob: '{"a":1}',
    overviewBlob: '{"b":2}',
    tagIds: ["tag-1"],
    extra: { keyVersion: 1 },
  };

  it("includes id in body for create mode", async () => {
    const body = await buildEncryptedEntryBody({
      ...baseParams,
      mode: "create",
      entryId: "entry-new",
    });

    expect(body.id).toBe("entry-new");
    expect(body.encryptedBlob).toBe('enc:{"a":1}');
    expect(body.encryptedOverview).toBe('enc:{"b":2}');
    expect(body.tagIds).toEqual(["tag-1"]);
    expect(body.keyVersion).toBe(1);
  });

  it("omits id in body for edit mode", async () => {
    const body = await buildEncryptedEntryBody({
      ...baseParams,
      mode: "edit",
      entryId: "entry-existing",
    });

    expect(body.id).toBeUndefined();
    expect(body.encryptedBlob).toBe('enc:{"a":1}');
  });

  it("includes optional fields with null values, excludes undefined", async () => {
    const body = await buildEncryptedEntryBody({
      ...baseParams,
      mode: "create",
      entryId: "entry-1",
      optionals: {
        folderId: null,
        entryType: "LOGIN",
        requireReprompt: undefined,
      },
    });

    expect(body.folderId).toBeNull();
    expect(body.entryType).toBe("LOGIN");
    expect(body.requireReprompt).toBeUndefined();
    expect("requireReprompt" in body).toBe(false);
  });

  it("passes AAD to encryptData", async () => {
    const { encryptData } = await import("@/lib/crypto-client");

    const blobAAD = new Uint8Array([1, 2, 3]);
    const overviewAAD = new Uint8Array([4, 5, 6]);

    await buildEncryptedEntryBody({
      ...baseParams,
      mode: "create",
      entryId: "entry-aad",
      blobAAD,
      overviewAAD,
    });

    expect(encryptData).toHaveBeenCalledWith('{"a":1}', expect.any(Object), blobAAD);
    expect(encryptData).toHaveBeenCalledWith('{"b":2}', expect.any(Object), overviewAAD);
  });
});

describe("submitEntry", () => {
  it("calls fetchApi with POST method and body", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    const body = { id: "x", encryptedBlob: "enc" };
    const res = await submitEntry("/api/passwords", "POST", body);

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/passwords");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(body);

    fetchMock.mockRestore();
  });

  it("calls fetchApi with PUT method for edit", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const body = { encryptedBlob: "enc" };
    const res = await submitEntry("/api/passwords/entry-1", "PUT", body);

    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("PUT");

    fetchMock.mockRestore();
  });
});
