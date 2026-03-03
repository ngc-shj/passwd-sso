"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import { API_PATH } from "@/lib/constants";

function getAuthBasePath(): string {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${basePath}${API_PATH.API_ROOT}/auth`;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextAuthSessionProvider basePath={getAuthBasePath()}>
      {children}
    </NextAuthSessionProvider>
  );
}
