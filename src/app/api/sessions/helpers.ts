import type { NextRequest } from "next/server";

export function getSessionToken(req: NextRequest): string | null {
  const isProduction = process.env.NODE_ENV === "production";
  return isProduction
    ? req.cookies.get("__Secure-authjs.session-token")?.value ?? null
    : req.cookies.get("authjs.session-token")?.value ?? null;
}
