"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { fetchApi } from "@/lib/url-helpers";

interface TravelModeState {
  active: boolean;
  activatedAt: string | null;
  loading: boolean;
  error: string | null;
}

interface TravelModeContextValue extends TravelModeState {
  enable: () => Promise<boolean>;
  disable: (verifierHash: string) => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

const TravelModeContext = createContext<TravelModeContextValue | null>(null);

export function TravelModeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TravelModeState>({
    active: false,
    activatedAt: null,
    loading: true,
    error: null,
  });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchApi("/api/travel-mode");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({
        active: data.active,
        activatedAt: data.activatedAt,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const enable = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetchApi("/api/travel-mode/enable", { method: "POST" });
      if (!res.ok) return false;
      const data = await res.json();
      setState((prev) => ({
        ...prev,
        active: data.active,
        activatedAt: new Date().toISOString(),
        error: null,
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const disable = useCallback(
    async (verifierHash: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const res = await fetchApi("/api/travel-mode/disable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verifierHash }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (res.status === 401) {
            return { success: false, error: "INVALID_PASSPHRASE" };
          }
          if (res.status === 403) {
            return { success: false, error: "ACCOUNT_LOCKED" };
          }
          return { success: false, error: data.error || `HTTP ${res.status}` };
        }

        const data = await res.json();
        setState((prev) => ({
          ...prev,
          active: data.active,
          activatedAt: null,
          error: null,
        }));
        return { success: true };
      } catch {
        return { success: false, error: "NETWORK_ERROR" };
      }
    },
    [],
  );

  const value: TravelModeContextValue = {
    ...state,
    enable,
    disable,
    refresh: fetchStatus,
  };

  return (
    <TravelModeContext value={value}>
      {children}
    </TravelModeContext>
  );
}

export function useTravelMode(): TravelModeContextValue {
  const ctx = useContext(TravelModeContext);
  if (!ctx) {
    throw new Error("useTravelMode must be used within TravelModeProvider");
  }
  return ctx;
}
