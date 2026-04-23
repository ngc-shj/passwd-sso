"use client";

import { useState, useCallback, useRef, type ReactNode, createElement } from "react";
import { RepromptDialog } from "@/components/passwords/reprompt-dialog";

const CACHE_TTL_MS = 30_000; // 30 seconds

interface PendingVerification {
  entryId: string;
  callback: () => void;
  cancelCallback?: () => void;
}

export function useReprompt() {
  const [pending, setPending] = useState<PendingVerification | null>(null);

  const cacheRef = useRef<Map<string, number>>(new Map());

  const isCacheValid = useCallback((entryId: string) => {
    const verifiedAt = cacheRef.current.get(entryId);
    return verifiedAt !== undefined && Date.now() - verifiedAt <= CACHE_TTL_MS;
  }, []);

  const markVerified = useCallback((entryId: string) => {
    cacheRef.current.set(entryId, Date.now());
  }, []);

  const requireVerification = useCallback(
    (entryId: string, requireReprompt: boolean, callback: () => void) => {
      if (!requireReprompt || isCacheValid(entryId)) {
        callback();
        return;
      }
      setPending({ entryId, callback });
    },
    [isCacheValid],
  );

  /**
   * Create a guarded getter for CopyButton's `getValue` prop.
   * Returns a function that returns a Promise<string> — resolves after
   * reprompt verification (or immediately if not required / cached),
   * rejects if the user cancels.
   */
  const createGuardedGetter = useCallback(
    (entryId: string, requireReprompt: boolean, getter: () => string): (() => Promise<string>) => {
      if (!requireReprompt) return () => Promise.resolve(getter());
      return () => new Promise<string>((resolve, reject) => {
        if (isCacheValid(entryId)) {
          resolve(getter());
          return;
        }
        setPending({
          entryId,
          callback: () => resolve(getter()),
          cancelCallback: () => reject(new Error("cancelled")),
        });
      });
    },
    [isCacheValid],
  );

  const handleVerified = useCallback(() => {
    if (!pending) return;
    markVerified(pending.entryId);
    const cb = pending.callback;
    setPending(null);
    cb();
  }, [pending, markVerified]);

  const handleCancel = useCallback(() => {
    if (!pending) return;
    const cancel = pending.cancelCallback;
    setPending(null);
    cancel?.();
  }, [pending]);

  const repromptDialog: ReactNode = pending
    ? // eslint-disable-next-line react-hooks/refs -- cacheRef is only written in onVerified handler, not read during render
      createElement(RepromptDialog, {
        open: true,
        onVerified: handleVerified,
        onCancel: handleCancel,
      })
    : null;

  return { requireVerification, createGuardedGetter, repromptDialog };
}
