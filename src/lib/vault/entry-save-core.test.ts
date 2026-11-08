import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string, init?: RequestInit) =>
    init !== undefined ? fetch(path, init) : fetch(path),
  withBasePath: (p: string) => p,
  BASE_PATH: "",
}));

import { buildEncryptedEntryBody, submitEntry } from "@/lib/vault/entry-save-core";

describe("buildEncryptedEntryBody", () => {
  const seal = vi.fn(async (value: string, vaultType: string) => ({ ciphertext: `enc:${vaultType}:${value}`, iv: "iv", authTag: "tag" }));
  const baseParams = {
    seal,
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
    expect(body.encryptedBlob).toEqual({ ciphertext: 'enc:blob:{"a":1}', iv: "iv", authTag: "tag" });
    expect(body.encryptedOverview).toEqual({ ciphertext: 'enc:overview:{"b":2}', iv: "iv", authTag: "tag" });
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
    expect(body.encryptedBlob).toEqual({ ciphertext: 'enc:blob:{"a":1}', iv: "iv", authTag: "tag" });
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

  it("seals the blob at the blob vaultType and the overview at the overview vaultType", async () => {
    seal.mockClear();

    await buildEncryptedEntryBody({ ...baseParams, mode: "create", entryId: "entry-aad" });

    expect(seal.mock.calls).toEqual([['{"a":1}', "blob"], ['{"b":2}', "overview"]]);
  });
});

describe("submitEntry", () => {
  it("calls fetchApi with correct method and body", async () => {
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
});
