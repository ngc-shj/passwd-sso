"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { InlineDetailData } from "@/types/entry";
import { VAULT_STATUS } from "@/lib/constants";
import type { VaultStatus } from "@/lib/constants";

interface UsePasswordEntryDetailOpts {
  getDetail: (id: string) => Promise<InlineDetailData>;
  vaultStatus: VaultStatus;
}

interface UsePasswordEntryDetailResult {
  detailData: InlineDetailData | null;
  loading: boolean;
  error: Error | null;
  invalidate: () => void;
}

/**
 * Manages the fetch/decrypt lifecycle for a single vault entry detail.
 * Security invariants:
 *   - INV-C1.1: detailData is cleared immediately on entryId change (before new fetch resolves).
 *   - INV-C1.3: detailData is cleared when vaultStatus leaves UNLOCKED (defense-in-depth).
 *   - INV-C1.4: cancel flag prevents stale out-of-order fetch results from overwriting current state.
 *   - INV-C1.2: no hover/prefetch path — only fetches when entryId is non-null.
 *   - INV-C1.7: zero field-mapping — all assembly lives inside the caller's getDetail closure.
 */
export function usePasswordEntryDetail(
  entryId: string | null,
  opts: UsePasswordEntryDetailOpts,
): UsePasswordEntryDetailResult {
  const { getDetail, vaultStatus } = opts;

  // Fetched result and error are tagged with the entryId they belong to, so the
  // current values can be DERIVED during render (no synchronous setState in an effect).
  // When entryId changes, the tag no longer matches and the derived values become null
  // immediately — satisfying INV-C1.1 (one resident at a time) without an effect.
  const [result, setResult] = useState<{ id: string; data: InlineDetailData } | null>(null);
  const [errorState, setErrorState] = useState<{ id: string; err: Error } | null>(null);

  // Increments on each invalidate() so the fetch effect re-runs for an unchanged entryId.
  const [invalidateCounter, setInvalidateCounter] = useState(0);

  // Stable ref to the latest getDetail so the effect closure captures it
  // without becoming stale.
  const getDetailRef = useRef(getDetail);
  useEffect(() => {
    getDetailRef.current = getDetail;
  });

  // Fetch effect — only writes state ASYNCHRONOUSLY (in .then/.catch), never
  // synchronously in the effect body, so it does not trigger cascading renders.
  // INV-C1.2: no fetch unless an entryId is explicitly set and the vault is unlocked.
  // INV-C1.4: the cancel flag prevents an out-of-order stale resolve from writing back
  // (the derived guard below is a second line of defence).
  useEffect(() => {
    if (entryId === null || vaultStatus !== VAULT_STATUS.UNLOCKED) return;

    let cancelled = false;
    getDetailRef.current(entryId)
      .then((data) => {
        if (cancelled) return;
        setResult({ id: entryId, data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (process.env.NODE_ENV === "development") {
          console.error("[usePasswordEntryDetail] getDetail error:", wrapped);
        }
        setErrorState({ id: entryId, err: wrapped });
      });

    return () => {
      cancelled = true;
    };
    // invalidateCounter is intentionally included so invalidate() re-triggers the fetch.
  }, [entryId, vaultStatus, invalidateCounter]);

  // Derived during render (pure):
  // INV-C1.1: detailData is non-null only for the CURRENT entryId.
  // INV-C1.3: cleared whenever the vault is not UNLOCKED (defense-in-depth; the
  // primary clear-on-lock is the VaultGate unmount per the plan's INV-C1.3/C1.5).
  const unlocked = vaultStatus === VAULT_STATUS.UNLOCKED;
  const detailData = unlocked && result?.id === entryId ? result.data : null;
  const error = unlocked && errorState?.id === entryId ? errorState.err : null;
  const loading = entryId !== null && unlocked && detailData === null && error === null;

  // invalidate() runs from an event handler (edit-onSaved / refresh), not render, so
  // synchronous setState here is fine. Clearing result nulls detailData before the
  // re-fetch resolves (F2 — pane never shows stale plaintext after an edit).
  const invalidate = useCallback(() => {
    setResult(null);
    setErrorState(null);
    setInvalidateCounter((c) => c + 1);
  }, []);

  return { detailData, loading, error, invalidate };
}
