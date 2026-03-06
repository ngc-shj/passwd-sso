"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  SessionProvider as NextAuthSessionProvider,
  useSession,
} from "next-auth/react";
import { API_PATH } from "@/lib/constants";

function getAuthBasePath(): string {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${basePath}${API_PATH.API_ROOT}/auth`;
}

// Refetch session on every navigation since next-auth v5 beta doesn't auto-fetch
function SessionSync() {
  const { update } = useSession();
  const pathname = usePathname();

  useEffect(() => {
    update();
  }, [pathname, update]);

  return null;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextAuthSessionProvider basePath={getAuthBasePath()}>
      <SessionSync />
      {children}
    </NextAuthSessionProvider>
  );
}
