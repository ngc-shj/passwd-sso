// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  TeamVaultProvider,
  useTeamVault,
  useTeamVaultOptional,
  type TeamVaultContextValue,
} from "./team-vault-context";
import {
  generateECDHKeyPair,
  exportPrivateKey,
} from "@/lib/crypto/crypto-team";

// This file re-exports TeamVaultProvider/useTeamVault from ./team-vault-core.
// The provider's branching paths (cache, distribute, errors) are exhaustively
// covered in team-vault-core.test.tsx. Here we only verify:
//   1. The re-exports are wired correctly (no name typos in the barrel).
//   2. Real Web Crypto + ECDH key import works through the public API surface
//      — proving the encryption boundary is reachable without crypto mocks.

describe("team-vault-context (barrel re-exports)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("re-exports a working useTeamVaultOptional that returns null outside provider", () => {
    const { result } = renderHook(() => useTeamVaultOptional());
    expect(result.current).toBeNull();
  });

  it("re-exports a useTeamVault hook that throws outside its provider", () => {
    expect(() => renderHook(() => useTeamVault())).toThrow(
      /useTeamVault must be used within a TeamVaultProvider/,
    );
  });

  it("re-exports TeamVaultProvider so consumers receive a working context value", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TeamVaultProvider
        getEcdhPrivateKeyBytes={() => null}
        getUserId={() => null}
        vaultUnlocked={false}
      >
        {children}
      </TeamVaultProvider>
    );

    const { result } = renderHook(() => useTeamVault(), { wrapper });
    // Public API surface — these names must match what callers depend on.
    expect(typeof result.current.getTeamEncryptionKey).toBe("function");
    expect(typeof result.current.getTeamKeyInfo).toBe("function");
    expect(typeof result.current.getItemEncryptionKey).toBe("function");
    expect(typeof result.current.getEntryDecryptionKey).toBe("function");
    expect(typeof result.current.invalidateTeamKey).toBe("function");
    expect(typeof result.current.clearAll).toBe("function");
    expect(typeof result.current.distributePendingKeys).toBe("function");
  });

  it("getTeamEncryptionKey returns null without producing a crash when ECDH key is unavailable", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TeamVaultProvider
        getEcdhPrivateKeyBytes={() => null}
        getUserId={() => "user-1"}
        vaultUnlocked={false}
      >
        {children}
      </TeamVaultProvider>
    );

    const { result } = renderHook(() => useTeamVault(), { wrapper });
    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getTeamEncryptionKey("team-1");
    });
    // No ECDH key → null without throwing
    expect(key).toBeNull();
  });

  it("getTeamEncryptionKey returns null on network failure (real crypto path, fail-closed)", async () => {
    // Generate a real ECDH key pair via real Web Crypto, then export it as
    // pkcs8 so the provider's importKey call exercises the real path.
    const kp = await generateECDHKeyPair();
    const ecdhPrivBytes = await exportPrivateKey(kp.privateKey);

    const bytes: Uint8Array = new Uint8Array(ecdhPrivBytes);

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "internal" }),
    })) as unknown as typeof fetch;

    const wrapper = ({ children }: { children: ReactNode }) => (
      <TeamVaultProvider
        getEcdhPrivateKeyBytes={() => bytes}
        getUserId={() => "user-1"}
        vaultUnlocked={false}
      >
        {children}
      </TeamVaultProvider>
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useTeamVault(), { wrapper });
    let key: CryptoKey | null = null;
    await act(async () => {
      key = await result.current.getTeamEncryptionKey("team-1");
    });
    expect(key).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    // Provider must zero the ECDH key copy on failure
    expect(Array.from(bytes).every((b) => b === 0)).toBe(true);
    warnSpy.mockRestore();
  });

  it("clearAll and invalidateTeamKey are callable and return undefined (idempotent on empty state)", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TeamVaultProvider
        getEcdhPrivateKeyBytes={() => null}
        getUserId={() => null}
        vaultUnlocked={false}
      >
        {children}
      </TeamVaultProvider>
    );
    const { result } = renderHook(() => useTeamVault(), { wrapper });
    let ctx: TeamVaultContextValue | null = null;
    act(() => {
      result.current.clearAll();
      result.current.invalidateTeamKey("team-nonexistent");
      ctx = result.current;
    });
    expect(ctx).not.toBeNull();
  });
});
