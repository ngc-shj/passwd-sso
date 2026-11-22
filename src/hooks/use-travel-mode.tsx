"use client";

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { fetchApi } from "@/lib/url-helpers";
import { parseJsonBodyOnce, readApiErrorBody } from "@/lib/http/read-api-error-body";

interface TravelModeState {
  active: boolean;
  activatedAt: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * `error` is the route's error code (or NETWORK_ERROR / `HTTP <status>` when
 * the body carries none).
 */
export interface TravelModeEnableResult {
  success: boolean;
  error?: string;
}

/** `lockedUntil` accompanies ACCOUNT_LOCKED. */
export interface TravelModeDisableResult extends TravelModeEnableResult {
  lockedUntil?: string | null;
}

interface TravelModeContextValue extends TravelModeState {
  enable: () => Promise<TravelModeEnableResult>;
  disable: (verifierHash: string) => Promise<TravelModeDisableResult>;
  refresh: () => Promise<void>;
}

const TravelModeContext = createContext<TravelModeContextValue | null>(null);

/** The `active` flag a toggle response echoes, or `fallback` when it has none. */
function readActive(body: unknown, fallback: boolean): boolean {
  if (typeof body !== "object" || body === null || !("active" in body)) return fallback;
  return typeof body.active === "boolean" ? body.active : fallback;
}

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

  const enable = useCallback(async (): Promise<TravelModeEnableResult> => {
    try {
      const res = await fetchApi("/api/travel-mode/enable", { method: "POST" });
      if (!res.ok) {
        const body = await readApiErrorBody(res);
        return { success: false, error: body ? body.error : `HTTP ${res.status}` };
      }
      // Enabled: an unreadable echo means what was asked for.
      const active = readActive(await parseJsonBodyOnce(res), true);
      setState((prev) => ({
        ...prev,
        active,
        activatedAt: new Date().toISOString(),
        error: null,
      }));
      return { success: true };
    } catch {
      return { success: false, error: "NETWORK_ERROR" };
    }
  }, []);

  const disable = useCallback(
    async (verifierHash: string): Promise<TravelModeDisableResult> => {
      try {
        const res = await fetchApi("/api/travel-mode/disable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verifierHash }),
        });

        // Read the code, not the status: 401 is both a wrong passphrase
        // (INVALID_PASSPHRASE) and an expired session (UNAUTHORIZED).
        if (!res.ok) {
          const body = await readApiErrorBody(res);
          if (!body) return { success: false, error: `HTTP ${res.status}` };
          return { success: false, error: body.error, lockedUntil: body.lockedUntil };
        }

        // Disabled: an unreadable echo means what was asked for.
        const active = readActive(await parseJsonBodyOnce(res), false);
        setState((prev) => ({
          ...prev,
          active,
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
