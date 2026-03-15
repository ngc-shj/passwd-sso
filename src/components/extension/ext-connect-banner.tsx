"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Cable } from "lucide-react";
import { EXT_CONNECT_PARAM } from "@/lib/constants";

/**
 * Banner shown during browser extension connection flow.
 * Detects ext_connect=1 from the current URL's searchParams or
 * from the callbackUrl search parameter (set by proxy during redirect).
 */
export function ExtConnectBanner({ className }: { className?: string }) {
  const t = useTranslations("Extension");
  const searchParams = useSearchParams();

  // Direct: ?ext_connect=1 (on dashboard)
  // Indirect: ?callbackUrl=...ext_connect=1 (on sign-in page, redirected by proxy)
  const directConnect = searchParams.get(EXT_CONNECT_PARAM) === "1";
  const callbackUrl = searchParams.get("callbackUrl") ?? "";
  const indirectConnect = callbackUrl.includes(`${EXT_CONNECT_PARAM}=1`);

  if (!directConnect && !indirectConnect) return null;

  return (
    <div className={`flex items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300${className ? ` ${className}` : ""}`}>
      <Cable className="h-4 w-4 shrink-0" />
      <span>{t("connectingBanner")}</span>
    </div>
  );
}
