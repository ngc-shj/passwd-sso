import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequest } from "@/__tests__/helpers/request-builder";

const { mockLogAudit } = vi.hoisted(() => ({
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/audit/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit/audit")>(
    "@/lib/audit/audit",
  );
  return {
    ...actual,
    logAuditAsync: mockLogAudit,
  };
});

import { emitBridgeCodeIssueFailure } from "./bridge-code-failure";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";

function req() {
  return createRequest("POST", "http://localhost:3000/api/extension/bridge-code", {
    headers: { "user-agent": "test-ua" },
    body: {},
  });
}

describe("emitBridgeCodeIssueFailure", () => {
  beforeEach(() => {
    mockLogAudit.mockClear();
  });

  it("uses SYSTEM_ACTOR_ID and actorType=SYSTEM when userId is null", async () => {
    await emitBridgeCodeIssueFailure({
      req: req(),
      userId: null,
      tenantId: null,
      reason: "origin_disallowed",
    });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: AUDIT_SCOPE.PERSONAL,
        action: AUDIT_ACTION.EXTENSION_BRIDGE_CODE_ISSUE_FAILURE,
        userId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
        metadata: { reason: "origin_disallowed" },
      }),
    );
    const call = mockLogAudit.mock.calls[0][0];
    expect(call).not.toHaveProperty("tenantId");
  });

  it("does not set actorType when userId is provided", async () => {
    await emitBridgeCodeIssueFailure({
      req: req(),
      userId: "user-uuid",
      tenantId: "tenant-uuid",
      reason: "step_up_required",
    });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const call = mockLogAudit.mock.calls[0][0];
    expect(call.userId).toBe("user-uuid");
    expect(call.tenantId).toBe("tenant-uuid");
    expect(call).not.toHaveProperty("actorType");
    expect(call.metadata).toEqual({ reason: "step_up_required" });
  });

  it("merges dpopError only for reason='dpop_invalid'", async () => {
    await emitBridgeCodeIssueFailure({
      req: req(),
      userId: "user-uuid",
      tenantId: "tenant-uuid",
      reason: "dpop_invalid",
      dpopError: "DPOP_HTM_MISMATCH",
    });

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { reason: "dpop_invalid", dpopError: "DPOP_HTM_MISMATCH" },
      }),
    );
  });

  it("does not include dpopError for non-dpop reasons", async () => {
    await emitBridgeCodeIssueFailure({
      req: req(),
      userId: "user-uuid",
      tenantId: "tenant-uuid",
      reason: "rate_limit",
    });

    const call = mockLogAudit.mock.calls[0][0];
    expect(call.metadata).toEqual({ reason: "rate_limit" });
    expect(call.metadata).not.toHaveProperty("dpopError");
  });

  it("propagates rejection from logAuditAsync (logAuditAsync is MF2 in production)", async () => {
    mockLogAudit.mockRejectedValueOnce(new Error("audit pipeline failed"));

    // The helper does NOT wrap logAuditAsync in try/catch — it relies on
    // logAuditAsync's MF2 (never-throws) contract. This test pins that
    // behavior so a regression in MF2 surfaces here rather than as a
    // surprise 500 in the bridge-code route.
    await expect(
      emitBridgeCodeIssueFailure({
        req: req(),
        userId: null,
        tenantId: null,
        reason: "unauthenticated",
      }),
    ).rejects.toThrow("audit pipeline failed");
  });
});
