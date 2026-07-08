"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";
import { MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/constants/time";
import { VAULT_AUTO_LOCK_DEFAULT } from "@/lib/validations/common";

const DEFAULT_INACTIVITY_TIMEOUT_MS = VAULT_AUTO_LOCK_DEFAULT * MS_PER_MINUTE;
const ACTIVITY_CHECK_INTERVAL_MS = 30 * MS_PER_SECOND;

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
  const lastActivityRef = useRef(0);
  const autoLockMsRef = useRef(DEFAULT_INACTIVITY_TIMEOUT_MS);

  // Update timeout value when prop changes
  useEffect(() => {
    if (autoLockMinutes != null && autoLockMinutes > 0) {
      autoLockMsRef.current = autoLockMinutes * MS_PER_MINUTE;
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

    // Single idle timeout regardless of tab visibility. What we protect is
    // "the user walked away", measured by activity — not by which tab is front.
    const checkInactivity = () => {
      if (Date.now() - lastActivityRef.current > autoLockMsRef.current) {
        lock();
      }
    };

    // On return from a hidden tab, evaluate the timeout FIRST. Background tabs
    // have their setInterval throttled/suspended, so checkInactivity may never
    // fire while hidden past the threshold. If we blindly reset activity on
    // return, an aged-out session would escape the lock (fail-open). Only treat
    // the return as fresh activity when the threshold has not been exceeded.
    const handleVisibility = () => {
      if (document.hidden) return;
      if (Date.now() - lastActivityRef.current > autoLockMsRef.current) {
        lock();
      } else {
        updateActivity();
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
