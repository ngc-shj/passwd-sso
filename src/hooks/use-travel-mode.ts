"use client";

import { useState, useEffect, useCallback } from "react";

interface TravelModeState {
  active: boolean;
  activatedAt: string | null;
  loading: boolean;
  error: string | null;
}

export function useTravelMode() {
  const [state, setState] = useState<TravelModeState>({
    active: false,
    activatedAt: null,
    loading: true,
    error: null,
  });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/travel-mode");
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
      const res = await fetch("/api/travel-mode/enable", { method: "POST" });
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
        const res = await fetch("/api/travel-mode/disable", {
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

  return {
    ...state,
    enable,
    disable,
    refresh: fetchStatus,
  };
}
