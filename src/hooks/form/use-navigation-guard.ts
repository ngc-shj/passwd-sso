import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { resolveNavigationTarget } from "@/lib/client-navigation";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";

/**
 * Guards against both browser reload (beforeunload) and SPA navigation
 * (link clicks) when `dirty` is true. Returns state for rendering a
 * confirmation dialog.
 *
 * Usage:
 *   const guard = useNavigationGuard(isDirty);
 *   // render <AlertDialog open={guard.dialogOpen} ...>
 *   // on confirm: guard.confirmLeave()
 *   // on cancel:  guard.cancelLeave()
 */
export function useNavigationGuard(dirty: boolean) {
  const locale = useLocale();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const allowLeaveRef = useRef(false);
  const [prevDirty, setPrevDirty] = useState(dirty);

  // Browser reload / tab close guard
  useBeforeUnloadGuard(dirty);

  // Clear stale dialog state when dirty becomes false (adjust state during rendering)
  if (prevDirty !== dirty) {
    setPrevDirty(dirty);
    if (!dirty) {
      setDialogOpen(false);
      setPendingHref(null);
    }
  }

  // SPA link click interception
  useEffect(() => {
    allowLeaveRef.current = false;
    if (!dirty) return;

    const onClick = (event: MouseEvent) => {
      if (allowLeaveRef.current) return;

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;

      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const targetInfo = resolveNavigationTarget(
        anchor.href,
        window.location.origin,
        locale
      );
      if (!targetInfo.isInternal || !targetInfo.internalPath) return;

      const currentInfo = resolveNavigationTarget(
        currentPath,
        window.location.origin,
        locale
      );
      if (targetInfo.internalPath === currentInfo.internalPath) return;

      event.preventDefault();
      event.stopPropagation();
      setPendingHref(targetInfo.internalPath);
      setDialogOpen(true);
    };

    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, locale]);

  const confirmLeave = useCallback(() => {
    if (!pendingHref) return;
    setDialogOpen(false);
    setPendingHref(null);
    allowLeaveRef.current = true;
    router.push(pendingHref);
  }, [pendingHref, router]);

  const cancelLeave = useCallback(() => {
    setDialogOpen(false);
    setPendingHref(null);
  }, []);

  return { dialogOpen, confirmLeave, cancelLeave };
}
