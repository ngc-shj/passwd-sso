"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  SessionProvider as NextAuthSessionProvider,
  useSession,
} from "next-auth/react";
import { API_PATH } from "@/lib/constants";
import { setExpectedUser } from "@/lib/url-helpers";

function getAuthBasePath(): string {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${basePath}${API_PATH.API_ROOT}/auth`;
}

// Refetch session on every navigation since next-auth v5 beta doesn't auto-fetch
function SessionSync() {
  const { update } = useSession();
  const updateRef = useRef(update);
  const pathname = usePathname();

  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  useEffect(() => {
    updateRef.current();
  }, [pathname]);

  return null;
}

// Binds the page to the first user useSession names (see setExpectedUser in
// url-helpers). A refetch naming the same user, or no user, changes nothing; a
// different user reloads the page rather than re-binding it, so a flow still
// holding the first user's keys never gets a header naming the second. The
// binding guards fetchApi requests only; a flow's own checks between its
// awaits (the vault's lock epoch, which a user switch moves) still decide
// whether it may continue.
export function ExpectedUserSync() {
  const userId = useSession().data?.user?.id;

  useEffect(() => {
    if (userId) setExpectedUser(userId);
  }, [userId]);

  return null;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextAuthSessionProvider basePath={getAuthBasePath()}>
      <SessionSync />
      <ExpectedUserSync />
      {children}
    </NextAuthSessionProvider>
  );
}
