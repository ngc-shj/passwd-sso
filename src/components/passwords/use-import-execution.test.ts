// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ParsedEntry } from "@/components/passwords/password-import-types";
import { ENTRY_TYPE } from "@/lib/constants";

const { mockRunImportEntries, mockFireImportAudit, mockToastSuccess } = vi.hoisted(() => ({
  mockRunImportEntries: vi.fn(),
  mockFireImportAudit: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("@/components/passwords/password-import-importer", () => ({
  runImportEntries: mockRunImportEntries,
}));

vi.mock("@/components/passwords/password-import-steps", () => ({
  fireImportAudit: mockFireImportAudit,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
  },
}));

import { useImportExecution } from "@/components/passwords/use-import-execution";

function makeEntry(): ParsedEntry {
  return {
    entryType: ENTRY_TYPE.LOGIN,
    title: "Example",
    username: "user@example.com",
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
    tags: [],
    customFields: [],
    totp: null,
    generatorSettings: null,
    passwordHistory: [],
    requireReprompt: false,
  };
}

describe("useImportExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs personal import and triggers audit + completion", async () => {
    mockRunImportEntries.mockResolvedValue({ successCount: 2, failedCount: 1 });
    const onComplete = vi.fn();
    const t = (key: string) => key;

    const { result } = renderHook(() =>
      useImportExecution({
        t,
        onComplete,
        isOrgImport: false,
        tagsPath: "/api/tags",
        passwordsPath: "/api/passwords",
        sourceFilename: "input.json",
        encryptedInput: true,
        userId: "u1",
        encryptionKey: {} as CryptoKey,
      })
    );

    await act(async () => {
      await result.current.runImport([makeEntry(), makeEntry(), makeEntry()]);
    });

    expect(mockRunImportEntries).toHaveBeenCalledTimes(1);
    expect(mockFireImportAudit).toHaveBeenCalledWith(3, 2, 1, "input.json", true);
    expect(mockToastSuccess).toHaveBeenCalledWith("importedCount");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.current.done).toBe(true);
    expect(result.current.result).toEqual({ success: 2, failed: 1 });
  });

  it("does not send audit for org import", async () => {
    mockRunImportEntries.mockResolvedValue({ successCount: 1, failedCount: 0 });
    const onComplete = vi.fn();

    const { result } = renderHook(() =>
      useImportExecution({
        t: (key: string) => key,
        onComplete,
        isOrgImport: true,
        tagsPath: "/api/teams/o1/tags",
        passwordsPath: "/api/teams/o1/passwords",
        sourceFilename: "org.csv",
        encryptedInput: false,
        orgEncryptionKey: {} as CryptoKey,
        orgKeyVersion: 1,
        orgId: "o1",
      })
    );

    await act(async () => {
      await result.current.runImport([makeEntry()]);
    });

    expect(mockFireImportAudit).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("skips execution when personal import has no encryption key", async () => {
    const { result } = renderHook(() =>
      useImportExecution({
        t: (key: string) => key,
        onComplete: vi.fn(),
        isOrgImport: false,
        tagsPath: "/api/tags",
        passwordsPath: "/api/passwords",
        sourceFilename: "x.csv",
        encryptedInput: false,
      })
    );

    await act(async () => {
      await result.current.runImport([makeEntry()]);
    });

    expect(mockRunImportEntries).not.toHaveBeenCalled();
    expect(result.current.done).toBe(false);
    expect(result.current.result).toEqual({ success: 0, failed: 0 });
  });

  it("resets importing to false when import throws", async () => {
    mockRunImportEntries.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() =>
      useImportExecution({
        t: (key: string) => key,
        onComplete: vi.fn(),
        isOrgImport: false,
        tagsPath: "/api/tags",
        passwordsPath: "/api/passwords",
        sourceFilename: "x.csv",
        encryptedInput: false,
        encryptionKey: {} as CryptoKey,
      })
    );

    await expect(
      act(async () => {
        await result.current.runImport([makeEntry()]);
      })
    ).rejects.toThrow("network");

    expect(result.current.importing).toBe(false);
    expect(result.current.done).toBe(false);
    expect(mockFireImportAudit).not.toHaveBeenCalled();
  });
});
