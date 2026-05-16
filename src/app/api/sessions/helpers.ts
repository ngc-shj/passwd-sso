import type { NextRequest } from "next/server";
import {
  getSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "@/lib/auth/session/cookie-name";

export function getSessionToken(req: NextRequest): string | null {
  const name = getSessionCookieName({
    useSecureCookies: isSecureCookieFromAuthUrl(),
    basePath: process.env.NEXT_PUBLIC_BASE_PATH,
  });
  return req.cookies.get(name)?.value ?? null;
}
