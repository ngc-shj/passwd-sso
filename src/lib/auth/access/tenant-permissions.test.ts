import { describe, it, expect, vi } from "vitest";

// tenant-auth.ts imports @/lib/prisma; stub it so the re-export pin can load it.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { hasTenantPermission } from "./tenant-permissions";
import { hasTenantPermission as reExported } from "./tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";

describe("hasTenantPermission", () => {
  it.each(["OWNER", "ADMIN"] as const)("grants every tenant permission to %s", (role) => {
    for (const permission of Object.values(TENANT_PERMISSION)) {
      expect(hasTenantPermission(role, permission)).toBe(true);
    }
  });

  it("grants no tenant permission to MEMBER", () => {
    for (const permission of Object.values(TENANT_PERMISSION)) {
      expect(hasTenantPermission("MEMBER", permission)).toBe(false);
    }
  });

  it("denies an unknown role", () => {
    expect(hasTenantPermission("GUEST" as never, TENANT_PERMISSION.WEBHOOK_MANAGE)).toBe(false);
  });

  it("is the same function tenant-auth re-exports", () => {
    expect(reExported).toBe(hasTenantPermission);
  });
});
