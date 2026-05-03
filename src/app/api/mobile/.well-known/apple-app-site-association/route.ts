/**
 * GET /.well-known/apple-app-site-association — iOS Universal Link claim
 * file (Apple App Site Association, AASA).
 *
 * Apple's Universal Link spec requires this file to be served at the **root**
 * `https://<host>/.well-known/apple-app-site-association` path with
 * `Content-Type: application/json`. For deployments mounted under a basePath
 * (e.g. `https://www.jpng.jp/passwd-sso`), the AASA file MUST live at the
 * site root, NOT inside the basePath.
 *
 * Operators wire this route to the root URL via their reverse proxy (Apache,
 * nginx, tailscale serve, etc.):
 *
 *   /.well-known/apple-app-site-association
 *     → /<basePath>/api/mobile/.well-known/apple-app-site-association
 *
 * Operator deployment env vars (NOT in the Zod schema — these are per-bundle
 * values set at deploy time):
 *
 *   IOS_APP_TEAM_ID   — Apple Developer Team ID (10-char string, e.g. ABCDE12345)
 *   IOS_APP_BUNDLE_ID — App bundle identifier (default: com.passwd-sso)
 */

import { NextResponse } from "next/server";
import { BASE_PATH } from "@/lib/url-helpers";

export const runtime = "nodejs";

const DEFAULT_BUNDLE_ID = "com.passwd-sso";

export function GET() {
  const teamId = process.env.IOS_APP_TEAM_ID;
  if (!teamId) {
    return NextResponse.json(
      { error: "IOS_APP_TEAM_ID is not configured on this server" },
      { status: 503 },
    );
  }
  const bundleId = process.env.IOS_APP_BUNDLE_ID || DEFAULT_BUNDLE_ID;
  const appID = `${teamId}.${bundleId}`;
  const callbackPath = `${BASE_PATH}/api/mobile/authorize/redirect`;

  const aasa = {
    applinks: {
      details: [
        {
          appIDs: [appID],
          components: [
            { "/": callbackPath, comment: "iOS auth callback" },
          ],
        },
      ],
    },
  };

  return NextResponse.json(aasa, {
    headers: {
      // Apple requires application/json (no charset); explicit Cache-Control
      // so reverse proxies don't cache stale TeamID rotations.
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
