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

// Names the page's user on every fetchApi request (see url-helpers). Updated
// only when the session names a user: a refetch keeps the last one, and an
// ended session keeps it too, so nothing this page still holds is sent under
// the next cookie. A passive effect, so it runs after VaultProvider's layout
// effect has dropped the keys and moved the lock epoch on a user switch — the
// binding never names the new user while the old user's keys still count.
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
