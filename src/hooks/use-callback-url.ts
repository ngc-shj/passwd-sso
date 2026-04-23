"use client";

import { useSearchParams } from "next/navigation";
import { resolveCallbackUrl } from "@/lib/auth/callback-url";

/**
 * Resolve the callbackUrl search parameter to a safe redirect target.
 * Client-only hook — uses window.location.origin for same-origin validation.
 */
export function useCallbackUrl(): string {
  const searchParams = useSearchParams();
  const raw = searchParams.get("callbackUrl");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return resolveCallbackUrl(raw, origin);
}
