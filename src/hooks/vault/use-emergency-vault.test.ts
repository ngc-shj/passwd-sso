// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { VAULT_STATUS } from "@/lib/constants";
import {
  buildEmergencyVaultFixture,
  type EmergencyVaultFixture,
} from "@/__tests__/helpers/emergency-vault-fixtures";

const { mockFetchApi, mockUseVault } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import { useEmergencyVault } from "./use-emergency-vault";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function serve(fx: EmergencyVaultFixture) {
  mockFetchApi.mockImplementation(async (path: string) =>
    path.endsWith("/vault/entries") ? json(fx.entriesBody) : json(fx.vaultBody),
  );
  mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: fx.granteeEncryptionKey });
}

describe("useEmergencyVault", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it("maps the decrypted overview onto the card, defaulting absent fields to null", async () => {
    const fx = await buildEmergencyVaultFixture([
      { id: "c1", entryType: "CREDIT_CARD", overview: { title: "Visa", brand: "visa", lastFour: "4242" }, blob: {} },
    ]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0].card).toMatchObject({
      id: "c1",
      entryType: "CREDIT_CARD",
      title: "Visa",
      brand: "visa",
      lastFour: "4242",
      username: null,
      tags: [],
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("decrypts a legacy (no-AAD) blob on demand", async () => {
    const fx = await buildEmergencyVaultFixture([
      { id: "l1", aadVersion: 0, overview: { title: "Old" }, blob: { password: "legacy-pw" } },
    ]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    const cb = result.current.entryCallbackMap.get("l1");
    await expect(cb?.getPassword()).resolves.toBe("legacy-pw");
    await expect(cb?.getUrl()).resolves.toBeNull();
  });

  it("returns an empty password and history when the blob has none", async () => {
    const fx = await buildEmergencyVaultFixture([{ id: "n1", overview: { title: "Note" }, blob: {} }]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    const cb = result.current.entryCallbackMap.get("n1");
    await expect(cb?.getPassword()).resolves.toBe("");
    await expect(cb?.getDetail()).resolves.toMatchObject({ passwordHistory: [] });
  });

  it("rejects an on-demand decrypt after unmount clears the owner key", async () => {
    const fx = await buildEmergencyVaultFixture([{ id: "u1", overview: { title: "T" }, blob: { password: "p" } }]);
    serve(fx);
    const { result, unmount } = renderHook(() => useEmergencyVault("grant-1"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    const cb = result.current.entryCallbackMap.get("u1");

    unmount();

    await expect(cb?.getPassword()).rejects.toThrow("Owner key not available");
  });

  it("does not fetch until the vault is unlocked", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.LOCKED, encryptionKey: null });
    const { result } = renderHook(() => useEmergencyVault("grant-1"));

    expect(mockFetchApi).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.displayError).toBeNull();
  });

  it("exposes the expanded-card setter", async () => {
    const fx = await buildEmergencyVaultFixture([]);
    serve(fx);
    const { result } = renderHook(() => useEmergencyVault("grant-1"));

    act(() => result.current.setExpandedId("x"));
    expect(result.current.expandedId).toBe("x");
  });
});
