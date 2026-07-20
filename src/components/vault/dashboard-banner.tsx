"use client";

import type { ReactNode } from "react";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { cn } from "@/lib/utils";

/**
 * Width wrapper for dashboard-level banners (recovery-key, delegation-revoke).
 *
 * Aligns a banner's horizontal extent with the entry-display area below it:
 * same outer padding (`px-4 md:px-6`) and the same layout-mode-dependent
 * centered max-width used by PasswordDashboard (`max-w-[1024px]` in
 * master-detail, `max-w-4xl` in accordion). Without this, a banner rendered as
 * a direct child of `<main>` spans the full right pane and looks wider than the
 * entry list.
 */
export function DashboardBanner({ children }: { children: ReactNode }) {
  const layoutMode = useLayoutMode();

  return (
    <div className="px-4 pt-4 md:px-6 md:pt-6">
      <div
        className={cn(
          "mx-auto w-full",
          layoutMode === "master-detail" ? "max-w-[1024px]" : "max-w-4xl",
        )}
      >
        {children}
      </div>
    </div>
  );
}
