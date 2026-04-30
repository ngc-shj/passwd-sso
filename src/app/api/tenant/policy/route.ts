import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, rateLimited, unauthorized } from "@/lib/http/api-response";
import { AUDIT_ACTION } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { TAILNET_NAME_MAX_LENGTH } from "@/lib/validations";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { isValidCidr, extractClientIp } from "@/lib/auth/policy/ip-access";
import { invalidateTenantPolicyCache, wouldIpBeAllowed } from "@/lib/auth/policy/access-restriction";
import { invalidateLockoutThresholdCache } from "@/lib/auth/policy/account-lockout";
import { invalidateSessionTimeoutCacheForTenant } from "@/lib/auth/session/session-timeout";
import { invalidateTenantSessionsCache } from "@/lib/auth/session/user-session-invalidation";
import {
  pinLengthSchema,
  MAX_CIDRS,
  LOCKOUT_THRESHOLD_MIN,
  LOCKOUT_THRESHOLD_MAX,
  LOCKOUT_DURATION_MIN,
  LOCKOUT_DURATION_MAX,
  PASSWORD_MAX_AGE_MIN,
  PASSWORD_MAX_AGE_MAX,
  PASSWORD_EXPIRY_WARNING_MIN,
  PASSWORD_EXPIRY_WARNING_MAX,
  AUDIT_LOG_RETENTION_MIN,
  AUDIT_LOG_RETENTION_MAX,
  PASSKEY_GRACE_PERIOD_MIN,
  PASSKEY_GRACE_PERIOD_MAX,
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  MAX_CONCURRENT_SESSIONS_MIN,
  MAX_CONCURRENT_SESSIONS_MAX,
  SESSION_IDLE_TIMEOUT_MIN,
  SESSION_IDLE_TIMEOUT_MAX,
  SESSION_ABSOLUTE_TIMEOUT_MIN,
  SESSION_ABSOLUTE_TIMEOUT_MAX,
  EXTENSION_TOKEN_IDLE_TIMEOUT_MIN,
  EXTENSION_TOKEN_IDLE_TIMEOUT_MAX,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX,
  VAULT_AUTO_LOCK_MIN,
  VAULT_AUTO_LOCK_MAX,
  SA_TOKEN_MAX_EXPIRY_MIN,
  SA_TOKEN_MAX_EXPIRY_MAX,
  JIT_TOKEN_TTL_MIN,
  JIT_TOKEN_TTL_MAX,
  DELEGATION_TTL_MIN,
  DELEGATION_TTL_MAX,
} from "@/lib/validations/common";
import {
  IP_ADDRESS_MAX_LENGTH,
} from "@/lib/validations/common.server";

const policyLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// GET /api/tenant/policy — read tenant session policy
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  try {
    await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  const user = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenant: { select: {
        maxConcurrentSessions: true,
        sessionIdleTimeoutMinutes: true,
        sessionAbsoluteTimeoutMinutes: true,
        extensionTokenIdleTimeoutMinutes: true,
        extensionTokenAbsoluteTimeoutMinutes: true,
        vaultAutoLockMinutes: true,
        allowAppSideAutofill: true,
        allowedCidrs: true,
        tailscaleEnabled: true,
        tailscaleTailnet: true,
        requireMinPinLength: true,
        requirePasskey: true,
        requirePasskeyEnabledAt: true,
        passkeyGracePeriodDays: true,
        lockoutThreshold1: true,
        lockoutDuration1Minutes: true,
        lockoutThreshold2: true,
        lockoutDuration2Minutes: true,
        lockoutThreshold3: true,
        lockoutDuration3Minutes: true,
        passwordMaxAgeDays: true,
        passwordExpiryWarningDays: true,
        auditLogRetentionDays: true,
        tenantMinPasswordLength: true,
        tenantRequireUppercase: true,
        tenantRequireLowercase: true,
        tenantRequireNumbers: true,
        tenantRequireSymbols: true,
        saTokenMaxExpiryDays: true,
        jitTokenDefaultTtlSec: true,
        jitTokenMaxTtlSec: true,
        delegationDefaultTtlSec: true,
        delegationMaxTtlSec: true,
      } } },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  return NextResponse.json({
    maxConcurrentSessions: user?.tenant?.maxConcurrentSessions ?? null,
    sessionIdleTimeoutMinutes: user?.tenant?.sessionIdleTimeoutMinutes ?? 480,
    sessionAbsoluteTimeoutMinutes: user?.tenant?.sessionAbsoluteTimeoutMinutes ?? 43200,
    extensionTokenIdleTimeoutMinutes: user?.tenant?.extensionTokenIdleTimeoutMinutes ?? 10080,
    extensionTokenAbsoluteTimeoutMinutes: user?.tenant?.extensionTokenAbsoluteTimeoutMinutes ?? 43200,
    vaultAutoLockMinutes: user?.tenant?.vaultAutoLockMinutes ?? null,
    allowAppSideAutofill: user?.tenant?.allowAppSideAutofill ?? false,
    allowedCidrs: user?.tenant?.allowedCidrs ?? [],
    tailscaleEnabled: user?.tenant?.tailscaleEnabled ?? false,
    tailscaleTailnet: user?.tenant?.tailscaleTailnet ?? null,
    requireMinPinLength: user?.tenant?.requireMinPinLength ?? null,
    requirePasskey: user?.tenant?.requirePasskey ?? false,
    requirePasskeyEnabledAt: user?.tenant?.requirePasskeyEnabledAt ?? null,
    passkeyGracePeriodDays: user?.tenant?.passkeyGracePeriodDays ?? null,
    lockoutThreshold1: user?.tenant?.lockoutThreshold1 ?? null,
    lockoutDuration1Minutes: user?.tenant?.lockoutDuration1Minutes ?? null,
    lockoutThreshold2: user?.tenant?.lockoutThreshold2 ?? null,
    lockoutDuration2Minutes: user?.tenant?.lockoutDuration2Minutes ?? null,
    lockoutThreshold3: user?.tenant?.lockoutThreshold3 ?? null,
    lockoutDuration3Minutes: user?.tenant?.lockoutDuration3Minutes ?? null,
    passwordMaxAgeDays: user?.tenant?.passwordMaxAgeDays ?? null,
    passwordExpiryWarningDays: user?.tenant?.passwordExpiryWarningDays ?? null,
    auditLogRetentionDays: user?.tenant?.auditLogRetentionDays ?? null,
    tenantMinPasswordLength: user?.tenant?.tenantMinPasswordLength ?? null,
    tenantRequireUppercase: user?.tenant?.tenantRequireUppercase ?? false,
    tenantRequireLowercase: user?.tenant?.tenantRequireLowercase ?? false,
    tenantRequireNumbers: user?.tenant?.tenantRequireNumbers ?? false,
    tenantRequireSymbols: user?.tenant?.tenantRequireSymbols ?? false,
    saTokenMaxExpiryDays: user?.tenant?.saTokenMaxExpiryDays ?? null,
    jitTokenDefaultTtlSec: user?.tenant?.jitTokenDefaultTtlSec ?? null,
    jitTokenMaxTtlSec: user?.tenant?.jitTokenMaxTtlSec ?? null,
    delegationDefaultTtlSec: user?.tenant?.delegationDefaultTtlSec ?? null,
    delegationMaxTtlSec: user?.tenant?.delegationMaxTtlSec ?? null,
  });
}

// PATCH /api/tenant/policy — update tenant session policy
async function handlePATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await policyLimiter.check(`rl:tenant_policy:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  let membership;
  try {
    membership = await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  const {
    maxConcurrentSessions,
    sessionIdleTimeoutMinutes,
    sessionAbsoluteTimeoutMinutes,
    extensionTokenIdleTimeoutMinutes,
    extensionTokenAbsoluteTimeoutMinutes,
    vaultAutoLockMinutes,
    allowAppSideAutofill,
    allowedCidrs,
    tailscaleEnabled,
    tailscaleTailnet,
    requireMinPinLength,
    confirmLockout,
    requirePasskey,
    passkeyGracePeriodDays,
    lockoutThreshold1,
    lockoutDuration1Minutes,
    lockoutThreshold2,
    lockoutDuration2Minutes,
    lockoutThreshold3,
    lockoutDuration3Minutes,
    passwordMaxAgeDays,
    passwordExpiryWarningDays,
    auditLogRetentionDays,
    tenantMinPasswordLength,
    tenantRequireUppercase,
    tenantRequireLowercase,
    tenantRequireNumbers,
    tenantRequireSymbols,
    saTokenMaxExpiryDays,
    jitTokenDefaultTtlSec,
    jitTokenMaxTtlSec,
    delegationDefaultTtlSec,
    delegationMaxTtlSec,
  } = body;

  // Validate maxConcurrentSessions: null (unlimited) or positive integer
  if (maxConcurrentSessions !== null && maxConcurrentSessions !== undefined) {
    if (
      typeof maxConcurrentSessions !== "number" ||
      !Number.isInteger(maxConcurrentSessions) ||
      maxConcurrentSessions < MAX_CONCURRENT_SESSIONS_MIN ||
      maxConcurrentSessions > MAX_CONCURRENT_SESSIONS_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate vaultAutoLockMinutes: null (default 15min) or positive integer up to 24h
  if (vaultAutoLockMinutes !== null && vaultAutoLockMinutes !== undefined) {
    if (
      typeof vaultAutoLockMinutes !== "number" ||
      !Number.isInteger(vaultAutoLockMinutes) ||
      vaultAutoLockMinutes < VAULT_AUTO_LOCK_MIN ||
      vaultAutoLockMinutes > VAULT_AUTO_LOCK_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate allowAppSideAutofill: boolean (default false). Per-tenant opt-in
  // for the iOS host-app surfacing saved credentials to the system AutoFill
  // provider; default-deny protects against AutoFill phishing in apps that
  // do not publish AASA. (S24 of ios-autofill-mvp plan.)
  if (allowAppSideAutofill !== undefined && typeof allowAppSideAutofill !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate sessionIdleTimeoutMinutes: now non-nullable per design. null is rejected.
  if (sessionIdleTimeoutMinutes !== undefined) {
    if (
      sessionIdleTimeoutMinutes === null ||
      typeof sessionIdleTimeoutMinutes !== "number" ||
      !Number.isInteger(sessionIdleTimeoutMinutes) ||
      sessionIdleTimeoutMinutes < SESSION_IDLE_TIMEOUT_MIN ||
      sessionIdleTimeoutMinutes > SESSION_IDLE_TIMEOUT_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate sessionAbsoluteTimeoutMinutes (non-nullable; ASVS 5.0 V7.3.2)
  if (sessionAbsoluteTimeoutMinutes !== undefined) {
    if (
      sessionAbsoluteTimeoutMinutes === null ||
      typeof sessionAbsoluteTimeoutMinutes !== "number" ||
      !Number.isInteger(sessionAbsoluteTimeoutMinutes) ||
      sessionAbsoluteTimeoutMinutes < SESSION_ABSOLUTE_TIMEOUT_MIN ||
      sessionAbsoluteTimeoutMinutes > SESSION_ABSOLUTE_TIMEOUT_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate extensionTokenIdleTimeoutMinutes (non-nullable)
  if (extensionTokenIdleTimeoutMinutes !== undefined) {
    if (
      extensionTokenIdleTimeoutMinutes === null ||
      typeof extensionTokenIdleTimeoutMinutes !== "number" ||
      !Number.isInteger(extensionTokenIdleTimeoutMinutes) ||
      extensionTokenIdleTimeoutMinutes < EXTENSION_TOKEN_IDLE_TIMEOUT_MIN ||
      extensionTokenIdleTimeoutMinutes > EXTENSION_TOKEN_IDLE_TIMEOUT_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate extensionTokenAbsoluteTimeoutMinutes (non-nullable)
  if (extensionTokenAbsoluteTimeoutMinutes !== undefined) {
    if (
      extensionTokenAbsoluteTimeoutMinutes === null ||
      typeof extensionTokenAbsoluteTimeoutMinutes !== "number" ||
      !Number.isInteger(extensionTokenAbsoluteTimeoutMinutes) ||
      extensionTokenAbsoluteTimeoutMinutes < EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MIN ||
      extensionTokenAbsoluteTimeoutMinutes > EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate allowedCidrs: null/[] or array of valid CIDR strings, max 50
  if (allowedCidrs !== null && allowedCidrs !== undefined) {
    if (!Array.isArray(allowedCidrs)) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
    if (allowedCidrs.length > MAX_CIDRS) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: `Maximum ${MAX_CIDRS} CIDRs allowed` });
    }
    for (const cidr of allowedCidrs) {
      if (typeof cidr !== "string" || !isValidCidr(cidr)) {
        const truncated = typeof cidr === "string" ? cidr.slice(0, IP_ADDRESS_MAX_LENGTH) : String(cidr).slice(0, IP_ADDRESS_MAX_LENGTH);
        return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: `Invalid CIDR: ${truncated}` });
      }
    }
  }

  // Validate tailscaleEnabled: boolean
  if (tailscaleEnabled !== undefined && typeof tailscaleEnabled !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate tailscaleTailnet format before the DB read (pure string validation)
  if (tailscaleTailnet !== null && tailscaleTailnet !== undefined) {
    if (typeof tailscaleTailnet !== "string" || tailscaleTailnet.length > TAILNET_NAME_MAX_LENGTH) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
    // DNS hostname characters only: alphanumeric, hyphens, dots
    if (tailscaleTailnet.length > 0 && !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(tailscaleTailnet)) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "tailscaleTailnet must contain only valid DNS hostname characters (a-z, 0-9, hyphens, dots)" });
    }
  }

  // Validate requireMinPinLength: null (disabled) or integer within CTAP2 bounds
  if (requireMinPinLength !== null && requireMinPinLength !== undefined) {
    if (!pinLengthSchema.safeParse(requireMinPinLength).success) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate requirePasskey: boolean
  if (requirePasskey !== undefined && typeof requirePasskey !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate passkeyGracePeriodDays: null (immediate enforcement) or integer within bounds
  if (passkeyGracePeriodDays !== null && passkeyGracePeriodDays !== undefined) {
    if (
      typeof passkeyGracePeriodDays !== "number" ||
      !Number.isInteger(passkeyGracePeriodDays) ||
      passkeyGracePeriodDays < PASSKEY_GRACE_PERIOD_MIN ||
      passkeyGracePeriodDays > PASSKEY_GRACE_PERIOD_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate lockoutThreshold1: non-nullable; skip if null (do not write to DB)
  if (lockoutThreshold1 !== undefined && lockoutThreshold1 !== null) {
    if (
      typeof lockoutThreshold1 !== "number" ||
      !Number.isInteger(lockoutThreshold1) ||
      lockoutThreshold1 < LOCKOUT_THRESHOLD_MIN ||
      lockoutThreshold1 > LOCKOUT_THRESHOLD_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate lockoutDuration1Minutes: non-nullable; skip if null (do not write to DB)
  if (lockoutDuration1Minutes !== undefined && lockoutDuration1Minutes !== null) {
    if (
      typeof lockoutDuration1Minutes !== "number" ||
      !Number.isInteger(lockoutDuration1Minutes) ||
      lockoutDuration1Minutes < LOCKOUT_DURATION_MIN ||
      lockoutDuration1Minutes > LOCKOUT_DURATION_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate lockoutThreshold2: non-nullable; skip if null (do not write to DB)
  if (lockoutThreshold2 !== undefined && lockoutThreshold2 !== null) {
    if (
      typeof lockoutThreshold2 !== "number" ||
      !Number.isInteger(lockoutThreshold2) ||
      lockoutThreshold2 < LOCKOUT_THRESHOLD_MIN ||
      lockoutThreshold2 > LOCKOUT_THRESHOLD_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate lockoutDuration2Minutes: non-nullable; skip if null (do not write to DB)
  if (lockoutDuration2Minutes !== undefined && lockoutDuration2Minutes !== null) {
    if (
      typeof lockoutDuration2Minutes !== "number" ||
      !Number.isInteger(lockoutDuration2Minutes) ||
      lockoutDuration2Minutes < LOCKOUT_DURATION_MIN ||
      lockoutDuration2Minutes > LOCKOUT_DURATION_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate lockoutThreshold3: non-nullable; skip if null (do not write to DB)
  if (lockoutThreshold3 !== undefined && lockoutThreshold3 !== null) {
    if (
      typeof lockoutThreshold3 !== "number" ||
      !Number.isInteger(lockoutThreshold3) ||
      lockoutThreshold3 < LOCKOUT_THRESHOLD_MIN ||
      lockoutThreshold3 > LOCKOUT_THRESHOLD_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate lockoutDuration3Minutes: non-nullable; skip if null (do not write to DB)
  if (lockoutDuration3Minutes !== undefined && lockoutDuration3Minutes !== null) {
    if (
      typeof lockoutDuration3Minutes !== "number" ||
      !Number.isInteger(lockoutDuration3Minutes) ||
      lockoutDuration3Minutes < LOCKOUT_DURATION_MIN ||
      lockoutDuration3Minutes > LOCKOUT_DURATION_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate passwordMaxAgeDays: null (disabled) or integer within bounds
  if (passwordMaxAgeDays !== null && passwordMaxAgeDays !== undefined) {
    if (
      typeof passwordMaxAgeDays !== "number" ||
      !Number.isInteger(passwordMaxAgeDays) ||
      passwordMaxAgeDays < PASSWORD_MAX_AGE_MIN ||
      passwordMaxAgeDays > PASSWORD_MAX_AGE_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate passwordExpiryWarningDays: non-nullable; skip if null (do not write to DB)
  if (passwordExpiryWarningDays !== undefined && passwordExpiryWarningDays !== null) {
    if (
      typeof passwordExpiryWarningDays !== "number" ||
      !Number.isInteger(passwordExpiryWarningDays) ||
      passwordExpiryWarningDays < PASSWORD_EXPIRY_WARNING_MIN ||
      passwordExpiryWarningDays > PASSWORD_EXPIRY_WARNING_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate auditLogRetentionDays: null (forever) or integer within bounds
  if (auditLogRetentionDays !== null && auditLogRetentionDays !== undefined) {
    if (
      typeof auditLogRetentionDays !== "number" ||
      !Number.isInteger(auditLogRetentionDays) ||
      auditLogRetentionDays < AUDIT_LOG_RETENTION_MIN ||
      auditLogRetentionDays > AUDIT_LOG_RETENTION_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate tenantMinPasswordLength: non-nullable; skip if null (do not write to DB)
  if (tenantMinPasswordLength !== undefined && tenantMinPasswordLength !== null) {
    if (
      typeof tenantMinPasswordLength !== "number" ||
      !Number.isInteger(tenantMinPasswordLength) ||
      tenantMinPasswordLength < POLICY_MIN_PW_LENGTH_MIN ||
      tenantMinPasswordLength > POLICY_MIN_PW_LENGTH_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate tenantRequireUppercase: boolean
  if (tenantRequireUppercase !== undefined && typeof tenantRequireUppercase !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate tenantRequireLowercase: boolean
  if (tenantRequireLowercase !== undefined && typeof tenantRequireLowercase !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate tenantRequireNumbers: boolean
  if (tenantRequireNumbers !== undefined && typeof tenantRequireNumbers !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate tenantRequireSymbols: boolean
  if (tenantRequireSymbols !== undefined && typeof tenantRequireSymbols !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate saTokenMaxExpiryDays: null (no limit) or integer within bounds
  if (saTokenMaxExpiryDays !== null && saTokenMaxExpiryDays !== undefined) {
    if (
      typeof saTokenMaxExpiryDays !== "number" ||
      !Number.isInteger(saTokenMaxExpiryDays) ||
      saTokenMaxExpiryDays < SA_TOKEN_MAX_EXPIRY_MIN ||
      saTokenMaxExpiryDays > SA_TOKEN_MAX_EXPIRY_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate jitTokenDefaultTtlSec: null (use system default) or integer within bounds
  if (jitTokenDefaultTtlSec !== null && jitTokenDefaultTtlSec !== undefined) {
    if (
      typeof jitTokenDefaultTtlSec !== "number" ||
      !Number.isInteger(jitTokenDefaultTtlSec) ||
      jitTokenDefaultTtlSec < JIT_TOKEN_TTL_MIN ||
      jitTokenDefaultTtlSec > JIT_TOKEN_TTL_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate jitTokenMaxTtlSec: null (no limit) or integer within bounds
  if (jitTokenMaxTtlSec !== null && jitTokenMaxTtlSec !== undefined) {
    if (
      typeof jitTokenMaxTtlSec !== "number" ||
      !Number.isInteger(jitTokenMaxTtlSec) ||
      jitTokenMaxTtlSec < JIT_TOKEN_TTL_MIN ||
      jitTokenMaxTtlSec > JIT_TOKEN_TTL_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate delegationDefaultTtlSec: null (use system default) or integer within bounds
  if (delegationDefaultTtlSec !== null && delegationDefaultTtlSec !== undefined) {
    if (
      typeof delegationDefaultTtlSec !== "number" ||
      !Number.isInteger(delegationDefaultTtlSec) ||
      delegationDefaultTtlSec < DELEGATION_TTL_MIN ||
      delegationDefaultTtlSec > DELEGATION_TTL_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Validate delegationMaxTtlSec: null (no limit) or integer within bounds
  if (delegationMaxTtlSec !== null && delegationMaxTtlSec !== undefined) {
    if (
      typeof delegationMaxTtlSec !== "number" ||
      !Number.isInteger(delegationMaxTtlSec) ||
      delegationMaxTtlSec < DELEGATION_TTL_MIN ||
      delegationMaxTtlSec > DELEGATION_TTL_MAX
    ) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
    }
  }

  // Single DB read that covers all three validation needs:
  //   1. tailscale: check existing tailscaleTailnet when tailscaleEnabled=true without a new value
  //   2. cross-field: lockout thresholds/durations, password expiry, requirePasskey set-once
  //   3. self-lockout: current allowedCidrs/tailscaleEnabled to simulate the new policy
  const needsCurrentState =
    (tailscaleEnabled === true && tailscaleTailnet === undefined) ||
    requirePasskey !== undefined ||
    passkeyGracePeriodDays !== undefined ||
    lockoutThreshold1 !== undefined ||
    lockoutDuration1Minutes !== undefined ||
    lockoutThreshold2 !== undefined ||
    lockoutDuration2Minutes !== undefined ||
    lockoutThreshold3 !== undefined ||
    lockoutDuration3Minutes !== undefined ||
    passwordMaxAgeDays !== undefined ||
    passwordExpiryWarningDays !== undefined ||
    jitTokenDefaultTtlSec !== undefined ||
    jitTokenMaxTtlSec !== undefined ||
    delegationDefaultTtlSec !== undefined ||
    delegationMaxTtlSec !== undefined ||
    // vault-auto-lock <= min(session_idle, extension_token_idle) invariant
    vaultAutoLockMinutes !== undefined ||
    sessionIdleTimeoutMinutes !== undefined ||
    extensionTokenIdleTimeoutMinutes !== undefined ||
    ((allowedCidrs !== undefined || tailscaleEnabled !== undefined) && !confirmLockout);

  const currentTenant = needsCurrentState
    ? await withBypassRls(prisma, async () =>
        prisma.tenant.findUnique({
          where: { id: membership.tenantId },
          select: {
            tailscaleTailnet: true,
            tailscaleEnabled: true,
            allowedCidrs: true,
            requirePasskey: true,
            passkeyGracePeriodDays: true,
            lockoutThreshold1: true,
            lockoutDuration1Minutes: true,
            lockoutThreshold2: true,
            lockoutDuration2Minutes: true,
            lockoutThreshold3: true,
            lockoutDuration3Minutes: true,
            passwordMaxAgeDays: true,
            passwordExpiryWarningDays: true,
            jitTokenDefaultTtlSec: true,
            jitTokenMaxTtlSec: true,
            delegationDefaultTtlSec: true,
            delegationMaxTtlSec: true,
            vaultAutoLockMinutes: true,
            sessionIdleTimeoutMinutes: true,
            extensionTokenIdleTimeoutMinutes: true,
          },
        }),
      BYPASS_PURPOSE.CROSS_TENANT_LOOKUP)
    : null;

  // Validate tailscaleTailnet: required when tailscaleEnabled is true
  if (tailscaleEnabled === true) {
    if (tailscaleTailnet === undefined) {
      // Not in request — check if DB already has a value
      if (!currentTenant?.tailscaleTailnet) {
        return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "tailscaleTailnet is required when tailscaleEnabled is true" });
      }
    } else if (!tailscaleTailnet || typeof tailscaleTailnet !== "string" || tailscaleTailnet.trim().length === 0) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "tailscaleTailnet is required when tailscaleEnabled is true" });
    }
  }

  // Cross-field validation: lockout thresholds/durations must be strictly ascending.
  // Merge request values with current DB values, falling back to schema defaults when DB has no value.
  const DEFAULT_T1 = 5, DEFAULT_T2 = 10, DEFAULT_T3 = 15;
  const DEFAULT_D1 = 15, DEFAULT_D2 = 60, DEFAULT_D3 = 1440;

  const t1 = (lockoutThreshold1 !== undefined ? lockoutThreshold1 : currentTenant?.lockoutThreshold1) ?? DEFAULT_T1;
  const t2 = (lockoutThreshold2 !== undefined ? lockoutThreshold2 : currentTenant?.lockoutThreshold2) ?? DEFAULT_T2;
  const t3 = (lockoutThreshold3 !== undefined ? lockoutThreshold3 : currentTenant?.lockoutThreshold3) ?? DEFAULT_T3;
  const d1 = (lockoutDuration1Minutes !== undefined ? lockoutDuration1Minutes : currentTenant?.lockoutDuration1Minutes) ?? DEFAULT_D1;
  const d2 = (lockoutDuration2Minutes !== undefined ? lockoutDuration2Minutes : currentTenant?.lockoutDuration2Minutes) ?? DEFAULT_D2;
  const d3 = (lockoutDuration3Minutes !== undefined ? lockoutDuration3Minutes : currentTenant?.lockoutDuration3Minutes) ?? DEFAULT_D3;

  // Lockout thresholds must always be strictly ascending
  if (t1 >= t2 || t2 >= t3) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "Lockout thresholds must be strictly ascending: threshold1 < threshold2 < threshold3" });
  }

  // Lockout durations must always be strictly ascending
  if (d1 >= d2 || d2 >= d3) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "Lockout durations must be strictly ascending: duration1 < duration2 < duration3" });
  }

  // Cross-field: vault_auto_lock must not exceed idle timeouts.
  // When vault auto-lock is longer than the session/extension token idle
  // timeout, the vault stays decrypted after the token/session dies —
  // the "logged out but locally readable" state is confusing UX and
  // extends the effective credential-material lifetime unnecessarily.
  const mergedVaultAutoLock = vaultAutoLockMinutes !== undefined
    ? vaultAutoLockMinutes
    : currentTenant?.vaultAutoLockMinutes ?? null;
  const mergedSessionIdle = sessionIdleTimeoutMinutes !== undefined
    ? sessionIdleTimeoutMinutes
    : currentTenant?.sessionIdleTimeoutMinutes ?? null;
  const mergedExtIdle = extensionTokenIdleTimeoutMinutes !== undefined
    ? extensionTokenIdleTimeoutMinutes
    : currentTenant?.extensionTokenIdleTimeoutMinutes ?? null;

  if (
    typeof mergedVaultAutoLock === "number" &&
    typeof mergedSessionIdle === "number" &&
    mergedVaultAutoLock > mergedSessionIdle
  ) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      message: `vaultAutoLockMinutes (${mergedVaultAutoLock}) must be <= sessionIdleTimeoutMinutes (${mergedSessionIdle})`,
    });
  }
  if (
    typeof mergedVaultAutoLock === "number" &&
    typeof mergedExtIdle === "number" &&
    mergedVaultAutoLock > mergedExtIdle
  ) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      message: `vaultAutoLockMinutes (${mergedVaultAutoLock}) must be <= extensionTokenIdleTimeoutMinutes (${mergedExtIdle})`,
    });
  }

  // Password expiry warning must be less than max age when both are set
  const mergedMaxAge = passwordMaxAgeDays !== undefined ? passwordMaxAgeDays : currentTenant?.passwordMaxAgeDays;
  const mergedWarning = passwordExpiryWarningDays !== undefined ? passwordExpiryWarningDays : currentTenant?.passwordExpiryWarningDays;
  if (mergedMaxAge != null && mergedWarning != null && mergedWarning >= mergedMaxAge) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "passwordExpiryWarningDays must be less than passwordMaxAgeDays" });
  }

  // Cross-field validation: jitTokenDefaultTtlSec must be <= jitTokenMaxTtlSec when both set
  // Merge request value with current DB value so partial PATCH cannot break the invariant
  const mergedJitDefault = jitTokenDefaultTtlSec !== undefined ? jitTokenDefaultTtlSec : currentTenant?.jitTokenDefaultTtlSec ?? null;
  const mergedJitMax = jitTokenMaxTtlSec !== undefined ? jitTokenMaxTtlSec : currentTenant?.jitTokenMaxTtlSec ?? null;
  if (mergedJitDefault != null && mergedJitMax != null && mergedJitDefault > mergedJitMax) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "jitTokenDefaultTtlSec must be <= jitTokenMaxTtlSec" });
  }

  // Cross-field validation: delegationDefaultTtlSec must be <= delegationMaxTtlSec when both set
  // Merge request value with current DB value so partial PATCH cannot break the invariant
  const mergedDelegDefault = delegationDefaultTtlSec !== undefined ? delegationDefaultTtlSec : currentTenant?.delegationDefaultTtlSec ?? null;
  const mergedDelegMax = delegationMaxTtlSec !== undefined ? delegationMaxTtlSec : currentTenant?.delegationMaxTtlSec ?? null;
  if (mergedDelegDefault != null && mergedDelegMax != null && mergedDelegDefault > mergedDelegMax) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, { message: "delegationDefaultTtlSec must be <= delegationMaxTtlSec" });
  }

  // requirePasskeyEnabledAt set-once logic uses the already-fetched current state
  const currentRequirePasskey = currentTenant?.requirePasskey ?? false;

  // Self-lockout detection: check if the requester's IP would be allowed under the new policy
  const newAllowedCidrs = allowedCidrs !== undefined ? (allowedCidrs ?? []) : undefined;
  const newTailscaleEnabled = tailscaleEnabled !== undefined ? tailscaleEnabled : undefined;
  if (confirmLockout !== undefined && typeof confirmLockout !== "boolean") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if ((newAllowedCidrs !== undefined || newTailscaleEnabled !== undefined) && !confirmLockout) {
    const hypothetical = {
      allowedCidrs: newAllowedCidrs ?? currentTenant?.allowedCidrs ?? [],
      tailscaleEnabled: newTailscaleEnabled ?? currentTenant?.tailscaleEnabled ?? false,
      tailscaleTailnet: (tailscaleTailnet !== undefined ? tailscaleTailnet : currentTenant?.tailscaleTailnet) ?? null,
    };
    const clientIp = extractClientIp(req);
    const hasRestrictions = hypothetical.allowedCidrs.length > 0 || hypothetical.tailscaleEnabled;
    if (hasRestrictions && (!clientIp || !wouldIpBeAllowed(clientIp, hypothetical))) {
      const message = clientIp
        ? "Your current IP would be blocked by this policy. Set confirmLockout: true to proceed."
        : "Your IP could not be determined; you may be locked out by this policy. Set confirmLockout: true to proceed.";
      return NextResponse.json(
        { error: API_ERROR.SELF_LOCKOUT, message },
        { status: 409 },
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (maxConcurrentSessions !== undefined) {
    updateData.maxConcurrentSessions = maxConcurrentSessions ?? null;
  }
  if (sessionIdleTimeoutMinutes !== undefined) {
    updateData.sessionIdleTimeoutMinutes = sessionIdleTimeoutMinutes;
  }
  if (sessionAbsoluteTimeoutMinutes !== undefined) {
    updateData.sessionAbsoluteTimeoutMinutes = sessionAbsoluteTimeoutMinutes;
  }
  if (extensionTokenIdleTimeoutMinutes !== undefined) {
    updateData.extensionTokenIdleTimeoutMinutes = extensionTokenIdleTimeoutMinutes;
  }
  if (extensionTokenAbsoluteTimeoutMinutes !== undefined) {
    updateData.extensionTokenAbsoluteTimeoutMinutes = extensionTokenAbsoluteTimeoutMinutes;
  }
  if (vaultAutoLockMinutes !== undefined) {
    updateData.vaultAutoLockMinutes = vaultAutoLockMinutes ?? null;
  }
  if (allowAppSideAutofill !== undefined) {
    updateData.allowAppSideAutofill = allowAppSideAutofill;
  }
  if (allowedCidrs !== undefined) {
    updateData.allowedCidrs = allowedCidrs ?? [];
  }
  if (tailscaleEnabled !== undefined) {
    updateData.tailscaleEnabled = tailscaleEnabled;
  }
  if (tailscaleTailnet !== undefined) {
    updateData.tailscaleTailnet = tailscaleTailnet ?? null;
  }
  if (requireMinPinLength !== undefined) {
    updateData.requireMinPinLength = requireMinPinLength ?? null;
  }

  // requirePasskey + set-once requirePasskeyEnabledAt logic
  if (requirePasskey !== undefined) {
    updateData.requirePasskey = requirePasskey;
    if (requirePasskey === true && currentRequirePasskey === false) {
      // Transition false → true: record the timestamp
      updateData.requirePasskeyEnabledAt = new Date();
    } else if (requirePasskey === false) {
      // Disabled: clear the timestamp
      updateData.requirePasskeyEnabledAt = null;
    }
    // Already true → true: do NOT overwrite requirePasskeyEnabledAt
  }

  if (passkeyGracePeriodDays !== undefined) {
    updateData.passkeyGracePeriodDays = passkeyGracePeriodDays ?? null;
  }
  if (lockoutThreshold1 !== undefined && lockoutThreshold1 !== null) {
    updateData.lockoutThreshold1 = lockoutThreshold1;
  }
  if (lockoutDuration1Minutes !== undefined && lockoutDuration1Minutes !== null) {
    updateData.lockoutDuration1Minutes = lockoutDuration1Minutes;
  }
  if (lockoutThreshold2 !== undefined && lockoutThreshold2 !== null) {
    updateData.lockoutThreshold2 = lockoutThreshold2;
  }
  if (lockoutDuration2Minutes !== undefined && lockoutDuration2Minutes !== null) {
    updateData.lockoutDuration2Minutes = lockoutDuration2Minutes;
  }
  if (lockoutThreshold3 !== undefined && lockoutThreshold3 !== null) {
    updateData.lockoutThreshold3 = lockoutThreshold3;
  }
  if (lockoutDuration3Minutes !== undefined && lockoutDuration3Minutes !== null) {
    updateData.lockoutDuration3Minutes = lockoutDuration3Minutes;
  }
  if (passwordMaxAgeDays !== undefined) {
    updateData.passwordMaxAgeDays = passwordMaxAgeDays ?? null;
  }
  if (passwordExpiryWarningDays !== undefined && passwordExpiryWarningDays !== null) {
    updateData.passwordExpiryWarningDays = passwordExpiryWarningDays;
  }
  if (auditLogRetentionDays !== undefined) {
    updateData.auditLogRetentionDays = auditLogRetentionDays ?? null;
  }
  if (tenantMinPasswordLength !== undefined && tenantMinPasswordLength !== null) {
    updateData.tenantMinPasswordLength = tenantMinPasswordLength;
  }
  if (tenantRequireUppercase !== undefined) {
    updateData.tenantRequireUppercase = tenantRequireUppercase;
  }
  if (tenantRequireLowercase !== undefined) {
    updateData.tenantRequireLowercase = tenantRequireLowercase;
  }
  if (tenantRequireNumbers !== undefined) {
    updateData.tenantRequireNumbers = tenantRequireNumbers;
  }
  if (tenantRequireSymbols !== undefined) {
    updateData.tenantRequireSymbols = tenantRequireSymbols;
  }
  if (saTokenMaxExpiryDays !== undefined) {
    updateData.saTokenMaxExpiryDays = saTokenMaxExpiryDays ?? null;
  }
  if (jitTokenDefaultTtlSec !== undefined) {
    updateData.jitTokenDefaultTtlSec = jitTokenDefaultTtlSec ?? null;
  }
  if (jitTokenMaxTtlSec !== undefined) {
    updateData.jitTokenMaxTtlSec = jitTokenMaxTtlSec ?? null;
  }
  if (delegationDefaultTtlSec !== undefined) {
    updateData.delegationDefaultTtlSec = delegationDefaultTtlSec ?? null;
  }
  if (delegationMaxTtlSec !== undefined) {
    updateData.delegationMaxTtlSec = delegationMaxTtlSec ?? null;
  }

  // Cascade clamp: when tenant lowers session idle/absolute, clamp team
   // overrides that exceed the new value in the same transaction. Use
   // Serializable to prevent TOCTOU with concurrent team policy PATCHes.
  const clampIdleTo = typeof sessionIdleTimeoutMinutes === "number" ? sessionIdleTimeoutMinutes : null;
  const clampAbsoluteTo = typeof sessionAbsoluteTimeoutMinutes === "number" ? sessionAbsoluteTimeoutMinutes : null;
  const clampedTeams: Array<{ teamId: string; field: string; previousValue: number; newValue: number }> = [];

  const updated = await withBypassRls(prisma, async () =>
    prisma.$transaction(async (tx) => {
      if (clampIdleTo !== null) {
        const affected = await tx.teamPolicy.findMany({
          where: {
            team: { tenantId: membership.tenantId },
            sessionIdleTimeoutMinutes: { gt: clampIdleTo },
          },
          select: { teamId: true, sessionIdleTimeoutMinutes: true },
        });
        for (const row of affected) {
          clampedTeams.push({
            teamId: row.teamId,
            field: "sessionIdleTimeoutMinutes",
            previousValue: row.sessionIdleTimeoutMinutes!,
            newValue: clampIdleTo,
          });
        }
        if (affected.length > 0) {
          await tx.teamPolicy.updateMany({
            where: { teamId: { in: affected.map((a) => a.teamId) } },
            data: { sessionIdleTimeoutMinutes: clampIdleTo },
          });
        }
      }
      if (clampAbsoluteTo !== null) {
        const affected = await tx.teamPolicy.findMany({
          where: {
            team: { tenantId: membership.tenantId },
            sessionAbsoluteTimeoutMinutes: { gt: clampAbsoluteTo },
          },
          select: { teamId: true, sessionAbsoluteTimeoutMinutes: true },
        });
        for (const row of affected) {
          clampedTeams.push({
            teamId: row.teamId,
            field: "sessionAbsoluteTimeoutMinutes",
            previousValue: row.sessionAbsoluteTimeoutMinutes!,
            newValue: clampAbsoluteTo,
          });
        }
        if (affected.length > 0) {
          await tx.teamPolicy.updateMany({
            where: { teamId: { in: affected.map((a) => a.teamId) } },
            data: { sessionAbsoluteTimeoutMinutes: clampAbsoluteTo },
          });
        }
      }
      return tx.tenant.update({
        where: { id: membership.tenantId },
        data: updateData,
        select: {
          maxConcurrentSessions: true,
          sessionIdleTimeoutMinutes: true,
          sessionAbsoluteTimeoutMinutes: true,
          extensionTokenIdleTimeoutMinutes: true,
          extensionTokenAbsoluteTimeoutMinutes: true,
          vaultAutoLockMinutes: true,
          allowAppSideAutofill: true,
          allowedCidrs: true,
          tailscaleEnabled: true,
          tailscaleTailnet: true,
          requireMinPinLength: true,
          requirePasskey: true,
          requirePasskeyEnabledAt: true,
          passkeyGracePeriodDays: true,
          lockoutThreshold1: true,
          lockoutDuration1Minutes: true,
          lockoutThreshold2: true,
          lockoutDuration2Minutes: true,
          lockoutThreshold3: true,
          lockoutDuration3Minutes: true,
          passwordMaxAgeDays: true,
          passwordExpiryWarningDays: true,
          auditLogRetentionDays: true,
          tenantMinPasswordLength: true,
          tenantRequireUppercase: true,
          tenantRequireLowercase: true,
          tenantRequireNumbers: true,
          tenantRequireSymbols: true,
          saTokenMaxExpiryDays: true,
          jitTokenDefaultTtlSec: true,
          jitTokenMaxTtlSec: true,
          delegationDefaultTtlSec: true,
          delegationMaxTtlSec: true,
        },
      });
    }, { isolationLevel: "Serializable" }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // Bust the tenant policy cache so access restriction picks up new values immediately
  invalidateTenantPolicyCache(membership.tenantId);
  invalidateLockoutThresholdCache(membership.tenantId);
  invalidateSessionTimeoutCacheForTenant(membership.tenantId);

  // R3 site #9 (S-Req-7): when requirePasskey or passkeyGracePeriodDays
  // change, invalidate every active cached session for this tenant so the
  // proxy stops serving the stale tenant-policy snapshot embedded in
  // SessionInfo. Synchronous (no fire-and-forget) — operators rely on the
  // post-PATCH state being authoritative. Bulk-pipelined to bound latency
  // for enterprise tenants (S-13).
  const requirePasskeyChanged =
    updateData.requirePasskey !== undefined &&
    (currentTenant?.requirePasskey ?? false) !== updateData.requirePasskey;
  const gracePeriodChanged =
    updateData.passkeyGracePeriodDays !== undefined &&
    (currentTenant?.passkeyGracePeriodDays ?? null) !== updateData.passkeyGracePeriodDays;

  if (requirePasskeyChanged || gracePeriodChanged) {
    await invalidateTenantSessionsCache(membership.tenantId);
  }

  // Audit any team-policy clamping that cascaded from this tenant change.
  for (const c of clampedTeams) {
    await logAuditAsync({
      ...tenantAuditBase(req, session.user.id, membership.tenantId),
      action: AUDIT_ACTION.TEAM_POLICY_CLAMPED_BY_TENANT,
      metadata: {
        teamId: c.teamId,
        field: c.field,
        previousValue: c.previousValue,
        newValue: c.newValue,
      },
    });
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, membership.tenantId),
    action: AUDIT_ACTION.POLICY_UPDATE,
    metadata: {
      maxConcurrentSessions: updated.maxConcurrentSessions,
      sessionIdleTimeoutMinutes: updated.sessionIdleTimeoutMinutes,
      sessionAbsoluteTimeoutMinutes: updated.sessionAbsoluteTimeoutMinutes,
      extensionTokenIdleTimeoutMinutes: updated.extensionTokenIdleTimeoutMinutes,
      extensionTokenAbsoluteTimeoutMinutes: updated.extensionTokenAbsoluteTimeoutMinutes,
      vaultAutoLockMinutes: updated.vaultAutoLockMinutes,
      allowAppSideAutofill: updated.allowAppSideAutofill,
      allowedCidrs: updated.allowedCidrs,
      tailscaleEnabled: updated.tailscaleEnabled,
      tailscaleTailnet: updated.tailscaleTailnet,
      requireMinPinLength: updated.requireMinPinLength,
      requirePasskey: updated.requirePasskey,
      requirePasskeyEnabledAt: updated.requirePasskeyEnabledAt,
      passkeyGracePeriodDays: updated.passkeyGracePeriodDays,
      lockoutThreshold1: updated.lockoutThreshold1,
      lockoutDuration1Minutes: updated.lockoutDuration1Minutes,
      lockoutThreshold2: updated.lockoutThreshold2,
      lockoutDuration2Minutes: updated.lockoutDuration2Minutes,
      lockoutThreshold3: updated.lockoutThreshold3,
      lockoutDuration3Minutes: updated.lockoutDuration3Minutes,
      passwordMaxAgeDays: updated.passwordMaxAgeDays,
      passwordExpiryWarningDays: updated.passwordExpiryWarningDays,
      auditLogRetentionDays: updated.auditLogRetentionDays,
      tenantMinPasswordLength: updated.tenantMinPasswordLength,
      tenantRequireUppercase: updated.tenantRequireUppercase,
      tenantRequireLowercase: updated.tenantRequireLowercase,
      tenantRequireNumbers: updated.tenantRequireNumbers,
      tenantRequireSymbols: updated.tenantRequireSymbols,
      saTokenMaxExpiryDays: updated.saTokenMaxExpiryDays,
      jitTokenDefaultTtlSec: updated.jitTokenDefaultTtlSec,
      jitTokenMaxTtlSec: updated.jitTokenMaxTtlSec,
      delegationDefaultTtlSec: updated.delegationDefaultTtlSec,
      delegationMaxTtlSec: updated.delegationMaxTtlSec,
    },
  });

  return NextResponse.json({
    maxConcurrentSessions: updated.maxConcurrentSessions,
    sessionIdleTimeoutMinutes: updated.sessionIdleTimeoutMinutes,
    sessionAbsoluteTimeoutMinutes: updated.sessionAbsoluteTimeoutMinutes,
    extensionTokenIdleTimeoutMinutes: updated.extensionTokenIdleTimeoutMinutes,
    extensionTokenAbsoluteTimeoutMinutes: updated.extensionTokenAbsoluteTimeoutMinutes,
    vaultAutoLockMinutes: updated.vaultAutoLockMinutes,
    allowAppSideAutofill: updated.allowAppSideAutofill,
    allowedCidrs: updated.allowedCidrs,
    tailscaleEnabled: updated.tailscaleEnabled,
    tailscaleTailnet: updated.tailscaleTailnet,
    requireMinPinLength: updated.requireMinPinLength,
    requirePasskey: updated.requirePasskey,
    requirePasskeyEnabledAt: updated.requirePasskeyEnabledAt,
    passkeyGracePeriodDays: updated.passkeyGracePeriodDays,
    lockoutThreshold1: updated.lockoutThreshold1,
    lockoutDuration1Minutes: updated.lockoutDuration1Minutes,
    lockoutThreshold2: updated.lockoutThreshold2,
    lockoutDuration2Minutes: updated.lockoutDuration2Minutes,
    lockoutThreshold3: updated.lockoutThreshold3,
    lockoutDuration3Minutes: updated.lockoutDuration3Minutes,
    passwordMaxAgeDays: updated.passwordMaxAgeDays,
    passwordExpiryWarningDays: updated.passwordExpiryWarningDays,
    auditLogRetentionDays: updated.auditLogRetentionDays,
    tenantMinPasswordLength: updated.tenantMinPasswordLength,
    tenantRequireUppercase: updated.tenantRequireUppercase,
    tenantRequireLowercase: updated.tenantRequireLowercase,
    tenantRequireNumbers: updated.tenantRequireNumbers,
    tenantRequireSymbols: updated.tenantRequireSymbols,
    saTokenMaxExpiryDays: updated.saTokenMaxExpiryDays,
    jitTokenDefaultTtlSec: updated.jitTokenDefaultTtlSec,
    jitTokenMaxTtlSec: updated.jitTokenMaxTtlSec,
    delegationDefaultTtlSec: updated.delegationDefaultTtlSec,
    delegationMaxTtlSec: updated.delegationMaxTtlSec,
  });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
