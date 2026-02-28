import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTRY_TYPE } from "@/lib/constants";
import type { ParsedEntry } from "@/components/passwords/password-import-types";
import {
  resolveFolderPathsForImport,
  resolveEntryFolderId,
} from "@/components/passwords/password-import-folders";

function makeEntry(folderPath: string): ParsedEntry {
  return {
    entryType: ENTRY_TYPE.LOGIN,
    title: "Example",
    username: "",
    password: "secret",
    content: "",
    url: "",
    notes: "",
    cardholderName: "",
    cardNumber: "",
    brand: "",
    expiryMonth: "",
    expiryYear: "",
    cvv: "",
    fullName: "",
    address: "",
    phone: "",
    email: "",
    dateOfBirth: "",
    nationality: "",
    idNumber: "",
    issueDate: "",
    expiryDate: "",
    relyingPartyId: "",
    relyingPartyName: "",
    credentialId: "",
    creationDate: "",
    deviceInfo: "",
    bankName: "",
    accountType: "",
    accountHolderName: "",
    accountNumber: "",
    routingNumber: "",
    swiftBic: "",
    iban: "",
    branchName: "",
    softwareName: "",
    licenseKey: "",
    version: "",
    licensee: "",
    purchaseDate: "",
    expirationDate: "",
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
    folderPath,
    isFavorite: false,
    expiresAt: null,
  };
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as unknown as Response;
}

function conflictResponse(): Response {
  return {
    ok: false,
    status: 409,
    json: async () => ({}),
  } as unknown as Response;
}

function failResponse(): Response {
  return {
    ok: false,
    status: 500,
    json: async () => ({}),
  } as unknown as Response;
}

describe("resolveFolderPathsForImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty map when no entries have folderPath", async () => {
    const fetcher = vi.fn();
    const result = await resolveFolderPathsForImport(
      [makeEntry("")],
      "/api/folders",
      fetcher,
    );
    expect(result.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves existing folder without creating", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse([
        { id: "f1", name: "Work", parentId: null },
      ]));

    const result = await resolveFolderPathsForImport(
      [makeEntry("Work")],
      "/api/folders",
      fetcher,
    );

    expect(result.get("Work")).toBe("f1");
    // Only GET, no POST
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("creates missing folder via POST", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse([])) // GET: no existing folders
      .mockResolvedValueOnce(jsonResponse({ id: "new-1" })); // POST: create "Work"

    const result = await resolveFolderPathsForImport(
      [makeEntry("Work")],
      "/api/folders",
      fetcher,
    );

    expect(result.get("Work")).toBe("new-1");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const postCall = fetcher.mock.calls[1];
    expect(postCall[0]).toBe("/api/folders");
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    expect(body.name).toBe("Work");
    expect(body.parentId).toBeNull();
  });

  it("creates nested folders parent-first with correct parentId", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse([])) // GET: empty
      .mockResolvedValueOnce(jsonResponse({ id: "parent-1" })) // POST: create "Parent"
      .mockResolvedValueOnce(jsonResponse({ id: "child-1" })); // POST: create "Child"

    const result = await resolveFolderPathsForImport(
      [makeEntry("Parent / Child")],
      "/api/folders",
      fetcher,
    );

    expect(result.get("Parent / Child")).toBe("child-1");
    // Verify parentId chain
    const parentBody = JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body));
    expect(parentBody.name).toBe("Parent");
    expect(parentBody.parentId).toBeNull();
    const childBody = JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body));
    expect(childBody.name).toBe("Child");
    expect(childBody.parentId).toBe("parent-1");
  });

  it("reuses existing parent and creates only child", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse([
        { id: "existing-parent", name: "Parent", parentId: null },
      ])) // GET: parent exists
      .mockResolvedValueOnce(jsonResponse({ id: "new-child" })); // POST: create "Child"

    const result = await resolveFolderPathsForImport(
      [makeEntry("Parent / Child")],
      "/api/folders",
      fetcher,
    );

    expect(result.get("Parent / Child")).toBe("new-child");
    const childBody = JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body));
    expect(childBody.parentId).toBe("existing-parent");
  });

  it("handles 409 Conflict by re-fetching", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse([])) // GET: empty
      .mockResolvedValueOnce(conflictResponse()) // POST: 409
      .mockResolvedValueOnce(jsonResponse([
        { id: "existing-1", name: "Work", parentId: null },
      ])); // GET refetch

    const result = await resolveFolderPathsForImport(
      [makeEntry("Work")],
      "/api/folders",
      fetcher,
    );

    expect(result.get("Work")).toBe("existing-1");
  });

  it("deduplicates entries with same folderPath", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse([])) // GET: empty
      .mockResolvedValueOnce(jsonResponse({ id: "f1" })); // POST: create once

    const result = await resolveFolderPathsForImport(
      [makeEntry("Work"), makeEntry("Work"), makeEntry("Work")],
      "/api/folders",
      fetcher,
    );

    expect(result.get("Work")).toBe("f1");
    // GET + 1 POST (not 3)
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("skips path on POST failure", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse([])) // GET: empty
      .mockResolvedValueOnce(failResponse()); // POST: 500

    const result = await resolveFolderPathsForImport(
      [makeEntry("Broken")],
      "/api/folders",
      fetcher,
    );

    expect(result.has("Broken")).toBe(false);
  });
});

describe("resolveEntryFolderId", () => {
  it("returns folderId from map", () => {
    const map = new Map([["Work", "f1"]]);
    expect(resolveEntryFolderId(makeEntry("Work"), map)).toBe("f1");
  });

  it("returns null for empty folderPath", () => {
    const map = new Map([["Work", "f1"]]);
    expect(resolveEntryFolderId(makeEntry(""), map)).toBeNull();
  });

  it("returns null for unresolved folderPath", () => {
    const map = new Map<string, string>();
    expect(resolveEntryFolderId(makeEntry("Unknown"), map)).toBeNull();
  });
});
