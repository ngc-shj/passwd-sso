"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { REVEAL_TIMEOUT_MS } from "@/lib/constants";

export type RequireVerificationFn = (
  entryId: string,
  requireReprompt: boolean,
  callback: () => void,
) => void;

export function useRevealTimeout(
  requireVerification: RequireVerificationFn,
  entryId: string,
  requireReprompt: boolean,
): { revealed: boolean; handleReveal: () => void; hide: () => void } {
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    setRevealed(false);
  }, []);

  const handleReveal = useCallback(() => {
    requireVerification(entryId, requireReprompt, () => {
      clearTimeout(timerRef.current);
      setRevealed(true);
      timerRef.current = setTimeout(() => setRevealed(false), REVEAL_TIMEOUT_MS);
    });
  }, [requireVerification, entryId, requireReprompt]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { revealed, handleReveal, hide };
}

export function useRevealSet(
  requireVerification: RequireVerificationFn,
  entryId: string,
  requireReprompt: boolean,
): {
  revealedSet: Set<number>;
  handleRevealIndex: (idx: number) => void;
  hideIndex: (idx: number) => void;
  isRevealed: (idx: number) => boolean;
} {
  const [revealedSet, setRevealedSet] = useState<Set<number>>(new Set());
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const hideIndex = useCallback((idx: number) => {
    const existing = timersRef.current.get(idx);
    if (existing !== undefined) {
      clearTimeout(existing);
      timersRef.current.delete(idx);
    }
    setRevealedSet((prev) => {
      if (!prev.has(idx)) return prev;
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  }, []);

  const handleRevealIndex = useCallback(
    (idx: number) => {
      if (revealedSet.has(idx)) {
        hideIndex(idx);
        return;
      }
      requireVerification(entryId, requireReprompt, () => {
        setRevealedSet((prev) => {
          const next = new Set(prev);
          next.add(idx);
          return next;
        });
        const existing = timersRef.current.get(idx);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
          setRevealedSet((prev) => {
            const next = new Set(prev);
            next.delete(idx);
            return next;
          });
          timersRef.current.delete(idx);
        }, REVEAL_TIMEOUT_MS);
        timersRef.current.set(idx, timer);
      });
    },
    [requireVerification, entryId, requireReprompt, revealedSet, hideIndex],
  );

  const isRevealed = useCallback((idx: number) => revealedSet.has(idx), [revealedSet]);

  useEffect(
    () => () => {
      timersRef.current.forEach((t) => clearTimeout(t));
    },
    [],
  );

  return { revealedSet, handleRevealIndex, hideIndex, isRevealed };
}
