/**
 * Shared admin bearer token verification for admin-only API endpoints.
 *
 * Uses ADMIN_API_TOKEN env var (64-char hex / 256-bit).
 * Compares via SHA-256 + timingSafeEqual to prevent timing attacks.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { HEX64_RE } from "@/lib/validations/common";

export function verifyAdminToken(req: NextRequest): boolean {
  const expectedHex = process.env.ADMIN_API_TOKEN;
  if (!expectedHex || !HEX64_RE.test(expectedHex)) return false;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const provided = authHeader.slice(7);
  if (!provided || !HEX64_RE.test(provided)) return false;

  // SHA-256 hash comparison with timingSafeEqual to prevent timing attacks
  const expectedHash = createHash("sha256")
    .update(Buffer.from(expectedHex, "hex"))
    .digest();
  const providedHash = createHash("sha256")
    .update(Buffer.from(provided, "hex"))
    .digest();

  return timingSafeEqual(expectedHash, providedHash);
}
