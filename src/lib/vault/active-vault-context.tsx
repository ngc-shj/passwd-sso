"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { VaultContext } from "@/hooks/use-vault-context";

interface ActiveVaultContextValue {
  vault: VaultContext | null;
  setVault: (v: VaultContext) => void;
}

const ActiveVaultCtx = createContext<ActiveVaultContextValue>({
  vault: null,
  setVault: () => {},
});

export function ActiveVaultProvider({ children }: { children: ReactNode }) {
  const [vault, setVaultState] = useState<VaultContext | null>(null);

  const setVault = useCallback((v: VaultContext) => {
    setVaultState((prev) => {
      if (prev?.type === v.type) {
        if (v.type === "personal") return prev;
        if (v.type === "team" && prev.type === "team" && prev.teamId === v.teamId)
          return prev;
      }
      return v;
    });
  }, []);

  return (
    <ActiveVaultCtx.Provider value={{ vault, setVault }}>
      {children}
    </ActiveVaultCtx.Provider>
  );
}

export function useActiveVault(): VaultContext | null {
  return useContext(ActiveVaultCtx).vault;
}

export function useSetActiveVault(): (v: VaultContext) => void {
  return useContext(ActiveVaultCtx).setVault;
}
