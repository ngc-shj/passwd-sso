/**
 * Emit EXTENSION_BRIDGE_CODE_ISSUE_FAILURE audit event for the
 * POST /api/extension/bridge-code route.
 *
 * Mirrors `emitAuthLoginFailure` for pre-auth (`userId === null`) cases:
 * the audit row is attributed to `SYSTEM_ACTOR_ID` with `actorType: SYSTEM`,
 * and the `tenantId` resolution dead-letters when no real user/tenant can
 * be associated. The synchronous pino structured-log emit at
 * `audit.ts:233-251` still fires for these dead-lettered rows, providing
 * the operational visibility for pre-auth failures.
 *
 * The `extra` shape is narrowed by discriminated union on `reason` so the
 * only field that can ever land in `metadata` (besides `reason` itself) is
 * the typed `DpopVerifyError` enum value — never a free-form string.
 */

import type { NextRequest } from "next/server";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import type { DpopVerifyError } from "@/lib/auth/dpop/verify";

export type BridgeCodeFailureReason =
  | "ip_rate_limit"
  | "ip_rate_limit_redis_fail"
  | "origin_disallowed"
  | "body_schema_invalid"
  | "unauthenticated"
  | "user_not_found"
  | "tenant_access_restricted"
  | "step_up_required"
  | "rate_limit"
  | "rate_limit_redis_fail"
  | "dpop_invalid"
  | "db_error";

export type BridgeCodeFailureArgs =
  | {
      req: NextRequest;
      userId: string | null;
      tenantId: string | null;
      reason: Exclude<BridgeCodeFailureReason, "dpop_invalid">;
    }
  | {
      req: NextRequest;
      userId: string | null;
      tenantId: string | null;
      reason: "dpop_invalid";
      dpopError: DpopVerifyError;
    };

export async function emitBridgeCodeIssueFailure(
  args: BridgeCodeFailureArgs,
): Promise<void> {
  const isPreAuth = args.userId === null;
  const effectiveUserId: string = args.userId ?? SYSTEM_ACTOR_ID;

  // personalAuditBase produces { scope, userId, ip, userAgent, acceptLanguage }.
  // We pass effectiveUserId so pre-auth callers always land on SYSTEM_ACTOR_ID.
  const base = personalAuditBase(args.req, effectiveUserId);

  const metadata: Record<string, unknown> = { reason: args.reason };
  if (args.reason === "dpop_invalid") {
    metadata.dpopError = args.dpopError;
  }

  // base from personalAuditBase already carries scope: PERSONAL.
  await logAuditAsync({
    ...base,
    ...(args.tenantId !== null && { tenantId: args.tenantId }),
    action: AUDIT_ACTION.EXTENSION_BRIDGE_CODE_ISSUE_FAILURE,
    metadata,
    ...(isPreAuth && { actorType: ACTOR_TYPE.SYSTEM }),
  });
}
