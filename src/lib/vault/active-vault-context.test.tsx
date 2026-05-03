// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ActiveVaultProvider,
  useActiveVault,
  useSetActiveVault,
} from "./active-vault-context";
import type { VaultContext } from "@/hooks/vault/use-vault-context";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ActiveVaultProvider>{children}</ActiveVaultProvider>
);

function useVaultPair() {
  return {
    vault: useActiveVault(),
    setVault: useSetActiveVault(),
  };
}

describe("ActiveVaultProvider", () => {
  it("starts with vault === null", () => {
    const { result } = renderHook(useVaultPair, { wrapper });
    expect(result.current.vault).toBeNull();
  });

  it("sets a personal vault when none was set", () => {
    const { result } = renderHook(useVaultPair, { wrapper });
    act(() => {
      result.current.setVault({ type: "personal" });
    });
    expect(result.current.vault).toEqual({ type: "personal" });
  });

  it("sets a team vault and propagates to consumers", () => {
    const { result } = renderHook(useVaultPair, { wrapper });
    const team: VaultContext = { type: "team", teamId: "team-1", teamName: "Eng" };
    act(() => {
      result.current.setVault(team);
    });
    expect(result.current.vault).toEqual(team);
  });

  it("preserves identity when setVault is called with the same personal type (no rerender churn)", () => {
    const { result } = renderHook(useVaultPair, { wrapper });
    act(() => {
      result.current.setVault({ type: "personal" });
    });
    const first = result.current.vault;
    act(() => {
      result.current.setVault({ type: "personal" });
    });
    // Identity must be preserved — no new object
    expect(result.current.vault).toBe(first);
  });

  it("preserves identity when setting the same team twice", () => {
    const { result } = renderHook(useVaultPair, { wrapper });
    act(() => {
      result.current.setVault({ type: "team", teamId: "team-1", teamName: "Eng" });
    });
    const first = result.current.vault;
    act(() => {
      // Different object, same teamId — must dedupe
      result.current.setVault({ type: "team", teamId: "team-1", teamName: "Eng v2" });
    });
    expect(result.current.vault).toBe(first);
  });

  it("switches when teamId changes (different team triggers replacement)", () => {
    const { result } = renderHook(useVaultPair, { wrapper });
    act(() => {
      result.current.setVault({ type: "team", teamId: "team-1" });
    });
    const first = result.current.vault;
    act(() => {
      result.current.setVault({ type: "team", teamId: "team-2" });
    });
    expect(result.current.vault).not.toBe(first);
    expect(result.current.vault).toEqual({ type: "team", teamId: "team-2" });
  });

  it("switches between personal and team (cross-type swap)", () => {
    const { result } = renderHook(useVaultPair, { wrapper });
    act(() => {
      result.current.setVault({ type: "personal" });
    });
    expect(result.current.vault?.type).toBe("personal");
    act(() => {
      result.current.setVault({ type: "team", teamId: "team-9" });
    });
    expect(result.current.vault).toEqual({ type: "team", teamId: "team-9" });
  });

  it("returns null and a no-op setter when consumer is outside the provider (default context)", () => {
    // No wrapper — uses default context value (vault: null, setVault: () => {})
    const { result } = renderHook(useVaultPair);
    expect(result.current.vault).toBeNull();
    // No throw — default setter is a no-op
    expect(() => {
      act(() => {
        result.current.setVault({ type: "personal" });
      });
    }).not.toThrow();
    expect(result.current.vault).toBeNull();
  });
});
