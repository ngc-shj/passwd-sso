import { describe, expect, it } from "vitest";
import {
  APPROVE_ELIGIBILITY,
  EXECUTE_ELIGIBILITY,
  REVOKE_ELIGIBILITY,
  computeApproveEligibility,
  computeExecuteEligibility,
  computeRevokeEligibility,
} from "./rotation-eligibility";

// Fixtures: stable IDs used across the table-driven tests so failures point
// at the specific dimension that diverged.
const NOW = new Date("2026-05-23T10:00:00Z");
const FUTURE = new Date("2026-05-24T10:00:00Z"); // +24h
const PAST = new Date("2026-05-23T09:00:00Z");   // -1h
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ALICE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("computeApproveEligibility", () => {
  it("returns CROSS_TENANT when actor tenant differs from rotation tenant", () => {
    expect(
      computeApproveEligibility({
        actorSubjectId: BOB,
        actorTenantId: TENANT_B,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.CROSS_TENANT);
  });

  it("returns INITIATOR when actor is the same user as the initiator", () => {
    expect(
      computeApproveEligibility({
        actorSubjectId: ALICE,
        actorTenantId: TENANT_A,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.INITIATOR);
  });

  it("returns ALREADY_TERMINAL when approvedAt is set", () => {
    expect(
      computeApproveEligibility({
        actorSubjectId: BOB,
        actorTenantId: TENANT_A,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: PAST,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ALREADY_TERMINAL when executedAt is set", () => {
    expect(
      computeApproveEligibility({
        actorSubjectId: BOB,
        actorTenantId: TENANT_A,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: PAST,
        executedAt: PAST,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ALREADY_TERMINAL when revokedAt is set", () => {
    expect(
      computeApproveEligibility({
        actorSubjectId: BOB,
        actorTenantId: TENANT_A,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: PAST,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ALREADY_TERMINAL when expiresAt <= now", () => {
    expect(
      computeApproveEligibility({
        actorSubjectId: BOB,
        actorTenantId: TENANT_A,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: PAST,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ELIGIBLE when all guards pass", () => {
    expect(
      computeApproveEligibility({
        actorSubjectId: BOB,
        actorTenantId: TENANT_A,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.ELIGIBLE);
  });

  it("treats null initiatedById as 'not self' (deleted-initiator case)", () => {
    // After User deletion the FK is null (per @relation onDelete: SetNull).
    // Without a known initiator we cannot reject self-approval; the CAS still
    // holds the row in a state that lets some other admin approve.
    expect(
      computeApproveEligibility({
        actorSubjectId: ALICE,
        actorTenantId: TENANT_A,
        initiatedById: null,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.ELIGIBLE);
  });

  it("CROSS_TENANT takes precedence over INITIATOR", () => {
    // If somehow Alice tries to approve a rotation from a different tenant
    // that lists her as initiator (degenerate), the cross-tenant gate fires
    // first. This pins the precedence and prevents subtle ordering bugs.
    expect(
      computeApproveEligibility({
        actorSubjectId: ALICE,
        actorTenantId: TENANT_B,
        initiatedById: ALICE,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(APPROVE_ELIGIBILITY.CROSS_TENANT);
  });
});

describe("computeExecuteEligibility", () => {
  it("returns CROSS_TENANT when actor tenant differs", () => {
    expect(
      computeExecuteEligibility({
        actorTenantId: TENANT_B,
        rotationTenantId: TENANT_A,
        approvedAt: PAST,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(EXECUTE_ELIGIBILITY.CROSS_TENANT);
  });

  it("returns NOT_APPROVED when approvedAt is null", () => {
    expect(
      computeExecuteEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(EXECUTE_ELIGIBILITY.NOT_APPROVED);
  });

  it("returns ALREADY_TERMINAL when executedAt is set", () => {
    expect(
      computeExecuteEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        approvedAt: PAST,
        executedAt: PAST,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(EXECUTE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ALREADY_TERMINAL when revokedAt is set", () => {
    expect(
      computeExecuteEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        approvedAt: PAST,
        executedAt: null,
        revokedAt: PAST,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(EXECUTE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ALREADY_TERMINAL when expiresAt <= now", () => {
    expect(
      computeExecuteEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        approvedAt: PAST,
        executedAt: null,
        revokedAt: null,
        expiresAt: PAST,
        now: NOW,
      }),
    ).toBe(EXECUTE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ELIGIBLE on the happy path", () => {
    expect(
      computeExecuteEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        approvedAt: PAST,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(EXECUTE_ELIGIBILITY.ELIGIBLE);
  });

  it("CROSS_TENANT takes precedence over NOT_APPROVED", () => {
    expect(
      computeExecuteEligibility({
        actorTenantId: TENANT_B,
        rotationTenantId: TENANT_A,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: FUTURE,
        now: NOW,
      }),
    ).toBe(EXECUTE_ELIGIBILITY.CROSS_TENANT);
  });
});

describe("computeRevokeEligibility", () => {
  it("returns CROSS_TENANT when actor tenant differs", () => {
    expect(
      computeRevokeEligibility({
        actorTenantId: TENANT_B,
        rotationTenantId: TENANT_A,
        executedAt: null,
        revokedAt: null,
      }),
    ).toBe(REVOKE_ELIGIBILITY.CROSS_TENANT);
  });

  it("returns ALREADY_TERMINAL when executedAt is set", () => {
    expect(
      computeRevokeEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        executedAt: PAST,
        revokedAt: null,
      }),
    ).toBe(REVOKE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ALREADY_TERMINAL when revokedAt is set", () => {
    expect(
      computeRevokeEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        executedAt: null,
        revokedAt: PAST,
      }),
    ).toBe(REVOKE_ELIGIBILITY.ALREADY_TERMINAL);
  });

  it("returns ELIGIBLE when no terminal flag is set (pending or approved-only)", () => {
    expect(
      computeRevokeEligibility({
        actorTenantId: TENANT_A,
        rotationTenantId: TENANT_A,
        executedAt: null,
        revokedAt: null,
      }),
    ).toBe(REVOKE_ELIGIBILITY.ELIGIBLE);
  });
});
