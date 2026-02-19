import { describe, expect, it, vi } from "vitest";
import { buildOrgPasswordLifecycleArgs } from "@/hooks/org-password-form-lifecycle-args";
import type { OrgPasswordFormLifecycleSetters } from "@/hooks/use-org-password-form-state";

describe("buildOrgPasswordLifecycleArgs", () => {
  it("maps model state into lifecycle args payload", () => {
    const onOpenChange = vi.fn();
    const setters = {} as OrgPasswordFormLifecycleSetters;

    const args = buildOrgPasswordLifecycleArgs({
      open: true,
      editData: null,
      onOpenChange,
      setters,
    });

    expect(args.open).toBe(true);
    expect(args.editData).toBeNull();
    expect(args.onOpenChange).toBe(onOpenChange);
    expect(args.setters).toBe(setters);
  });

  it("keeps editData undefined when omitted", () => {
    const args = buildOrgPasswordLifecycleArgs({
      open: true,
      onOpenChange: vi.fn(),
      setters: {} as OrgPasswordFormLifecycleSetters,
    });

    expect(args.editData).toBeUndefined();
  });
});
