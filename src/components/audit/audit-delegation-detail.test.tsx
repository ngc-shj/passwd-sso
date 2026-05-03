// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, renderHook } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AuditDelegationDetail, useAuditDelegationLabel } from "./audit-delegation-detail";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (!values) return key;
    return `${key}|${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(",")}`;
  },
}));

describe("useAuditDelegationLabel", () => {
  it("returns null when metadata is null", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    expect(result.current("DELEGATION_READ", null)).toBeNull();
  });

  it("returns null for an unrelated action", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    expect(result.current("ENTRY_CREATE", { entryCount: 1 })).toBeNull();
  });

  it("uses delegationListMeta for DELEGATION_READ + tool=list", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    const out = result.current("DELEGATION_READ", { tool: "list", entryCount: 7 });
    expect(out).toBe("delegationListMeta|entryCount=7");
  });

  it("uses delegationSearchMeta for DELEGATION_READ + tool=search with query", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    const out = result.current("DELEGATION_READ", {
      tool: "search",
      query: "github",
      entryCount: 2,
    });
    expect(out).toBe("delegationSearchMeta|query=github,entryCount=2");
  });

  it("falls back to delegationListMeta when DELEGATION_READ tool=search has empty query", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    const out = result.current("DELEGATION_READ", { tool: "search", entryCount: 3 });
    expect(out).toBe("delegationListMeta|entryCount=3");
  });

  it("uses delegationGetMeta for DELEGATION_READ + tool=get", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    expect(result.current("DELEGATION_READ", { tool: "get" })).toBe("delegationGetMeta");
  });

  it("uses delegationCreateMeta for DELEGATION_CREATE", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    expect(result.current("DELEGATION_CREATE", { entryCount: 5 })).toBe(
      "delegationCreateMeta|entryCount=5",
    );
  });

  it("uses delegationRevokeMeta for DELEGATION_REVOKE with defaults when fields absent", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    expect(result.current("DELEGATION_REVOKE", {})).toBe(
      "delegationRevokeMeta|revokedCount=1,reason=manual",
    );
  });

  it("coerces non-numeric entryCount to 0 (defensive)", () => {
    const { result } = renderHook(() => useAuditDelegationLabel());
    expect(result.current("DELEGATION_CREATE", { entryCount: "five" })).toBe(
      "delegationCreateMeta|entryCount=0",
    );
  });
});

describe("AuditDelegationDetail (component)", () => {
  it("renders nothing when getLabel returns null", () => {
    const { container } = render(
      <AuditDelegationDetail action="ENTRY_CREATE" metadata={{}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the resolved label when applicable", () => {
    render(
      <AuditDelegationDetail
        action="DELEGATION_CREATE"
        metadata={{ entryCount: 4 }}
      />,
    );
    expect(
      screen.getByText("delegationCreateMeta|entryCount=4"),
    ).toBeInTheDocument();
  });
});
