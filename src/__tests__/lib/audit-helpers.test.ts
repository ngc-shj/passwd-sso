import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import {
  personalAuditBase,
  teamAuditBase,
  tenantAuditBase,
} from "@/lib/audit/audit";
import { AUDIT_SCOPE } from "@/lib/constants/audit";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/test", { headers });
}

describe("personalAuditBase", () => {
  it("returns PERSONAL scope with userId", () => {
    const req = makeReq();
    const result = personalAuditBase(req, "user-1");
    expect(result.scope).toBe(AUDIT_SCOPE.PERSONAL);
    expect(result.userId).toBe("user-1");
  });

  it("includes ip, userAgent, acceptLanguage from request meta", () => {
    const req = makeReq({
      "x-forwarded-for": "203.0.113.5",
      "user-agent": "test-agent/1.0",
      "accept-language": "en-US,en;q=0.9",
    });
    const result = personalAuditBase(req, "user-1");
    expect(result).toHaveProperty("ip");
    expect(result.userAgent).toBe("test-agent/1.0");
    expect(result.acceptLanguage).toBe("en-US,en;q=0.9");
  });

  it("returns null ip/userAgent when headers absent", () => {
    const req = makeReq();
    const result = personalAuditBase(req, "user-1");
    expect(result.ip).toBeNull();
    expect(result.userAgent).toBeNull();
    expect(result.acceptLanguage).toBeNull();
  });

  it("does NOT set teamId or tenantId", () => {
    const req = makeReq();
    const result = personalAuditBase(req, "user-1") as Record<string, unknown>;
    expect(result.teamId).toBeUndefined();
    expect(result.tenantId).toBeUndefined();
  });
});

describe("teamAuditBase", () => {
  it("returns TEAM scope with userId and teamId", () => {
    const req = makeReq();
    const result = teamAuditBase(req, "user-1", "team-1");
    expect(result.scope).toBe(AUDIT_SCOPE.TEAM);
    expect(result.userId).toBe("user-1");
    expect(result.teamId).toBe("team-1");
  });

  it("does NOT set tenantId (caller must override if needed)", () => {
    const req = makeReq();
    const result = teamAuditBase(req, "user-1", "team-1") as Record<string, unknown>;
    expect(result.tenantId).toBeUndefined();
  });

  it("includes request meta (ip, userAgent, acceptLanguage)", () => {
    const req = makeReq({ "user-agent": "ua" });
    const result = teamAuditBase(req, "user-1", "team-1");
    expect(result.userAgent).toBe("ua");
    expect(result).toHaveProperty("ip");
    expect(result).toHaveProperty("acceptLanguage");
  });
});

describe("tenantAuditBase", () => {
  it("returns TENANT scope with userId and tenantId", () => {
    const req = makeReq();
    const result = tenantAuditBase(req, "user-1", "tenant-1");
    expect(result.scope).toBe(AUDIT_SCOPE.TENANT);
    expect(result.userId).toBe("user-1");
    expect(result.tenantId).toBe("tenant-1");
  });

  it("does NOT set teamId", () => {
    const req = makeReq();
    const result = tenantAuditBase(req, "user-1", "tenant-1") as Record<string, unknown>;
    expect(result.teamId).toBeUndefined();
  });

  it("includes request meta (ip, userAgent, acceptLanguage)", () => {
    const req = makeReq({ "user-agent": "ua" });
    const result = tenantAuditBase(req, "user-1", "tenant-1");
    expect(result.userAgent).toBe("ua");
    expect(result).toHaveProperty("ip");
    expect(result).toHaveProperty("acceptLanguage");
  });
});
