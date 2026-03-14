"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_HIDDEN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes when tab hidden
const ACTIVITY_CHECK_INTERVAL_MS = 30_000; // check every 30 seconds

interface AutoLockProviderProps {
  vaultStatus: VaultStatus;
  lock: () => void;
  autoLockMinutes: number | null;
  children: ReactNode;
}

export function AutoLockProvider({
  vaultStatus,
  lock,
  autoLockMinutes,
  children,
}: AutoLockProviderProps) {
  const lastActivityRef = useRef(Date.now());
  const hiddenAtRef = useRef<number | null>(null);
  const autoLockMsRef = useRef(DEFAULT_INACTIVITY_TIMEOUT_MS);
  const hiddenLockMsRef = useRef(DEFAULT_HIDDEN_TIMEOUT_MS);

  // Update timeout values when prop changes
  useEffect(() => {
    if (autoLockMinutes != null && autoLockMinutes > 0) {
      autoLockMsRef.current = autoLockMinutes * 60_000;
      hiddenLockMsRef.current = Math.min(autoLockMinutes * 60_000, DEFAULT_HIDDEN_TIMEOUT_MS);
    }
  }, [autoLockMinutes]);

  // Reset activity timestamp when vault becomes unlocked
  useEffect(() => {
    if (vaultStatus === VAULT_STATUS.UNLOCKED) {
      lastActivityRef.current = Date.now();
    }
  }, [vaultStatus]);

  // Auto-lock on inactivity
  useEffect(() => {
    if (vaultStatus !== VAULT_STATUS.UNLOCKED) return;

    const updateActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const handleVisibility = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
      } else {
        hiddenAtRef.current = null;
        updateActivity();
      }
    };

    const checkInactivity = () => {
      const now = Date.now();

      // When tab is hidden, only check hidden timeout (not inactivity).
      // The user may be active in other tabs — that's not "inactivity".
      if (document.hidden) {
        if (hiddenAtRef.current && now - hiddenAtRef.current > hiddenLockMsRef.current) {
          lock();
        }
        return;
      }

      // Tab is visible — check inactivity timeout
      const sinceActivity = now - lastActivityRef.current;
      if (sinceActivity > autoLockMsRef.current) {
        lock();
      }
    };

    window.addEventListener("mousemove", updateActivity);
    window.addEventListener("keydown", updateActivity);
    window.addEventListener("click", updateActivity);
    window.addEventListener("scroll", updateActivity, true);
    window.addEventListener("wheel", updateActivity, { passive: true });
    window.addEventListener("touchstart", updateActivity);
    document.addEventListener("visibilitychange", handleVisibility);

    const intervalId = setInterval(checkInactivity, ACTIVITY_CHECK_INTERVAL_MS);

    return () => {
      window.removeEventListener("mousemove", updateActivity);
      window.removeEventListener("keydown", updateActivity);
      window.removeEventListener("click", updateActivity);
      window.removeEventListener("scroll", updateActivity, true);
      window.removeEventListener("wheel", updateActivity, { passive: true } as EventListenerOptions);
      window.removeEventListener("touchstart", updateActivity);
      document.removeEventListener("visibilitychange", handleVisibility);
      clearInterval(intervalId);
    };
  }, [vaultStatus, lock]);

  return <>{children}</>;
}
