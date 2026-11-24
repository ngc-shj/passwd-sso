// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { deriveEncryptionKey, encryptData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import type { AuditLogItem } from "@/hooks/vault/use-audit-logs";

const { mockFetchApi, mockUseVault, mockUseSession } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
  mockUseSession: vi.fn(),
}));

vi.mock("next-intl", async () => {
  const { mockTranslator } = await import("@/__tests__/helpers/mock-translator");
  return {
    useTranslations: () =>
      mockTranslator((key: string, values?: Record<string, unknown>) =>
        values ? `${key}(${JSON.stringify(values)})` : key,
      ),
    useLocale: () => "en",
  };
});
vi.mock("next-auth/react", () => ({ useSession: mockUseSession }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import { usePersonalAuditLogs, PERSONAL_AUDIT_ACTION_GROUPS } from "./use-personal-audit-logs";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function item(action: string, extra: Partial<AuditLogItem> = {}): AuditLogItem {
  return {
    id: "l1",
    action,
    targetType: null,
    targetId: null,
    metadata: null,
    ip: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

let encryptionKey: CryptoKey;

describe("usePersonalAuditLogs", () => {
  beforeEach(async () => {
    mockFetchApi.mockReset();
    encryptionKey = await deriveEncryptionKey(new Uint8Array(32).fill(0x24));
    mockUseVault.mockReturnValue({ encryptionKey });
    mockUseSession.mockReturnValue({ data: { user: { id: "u1" } } });
  });

  it("includes the emergency group in the personal action groups", () => {
    expect(PERSONAL_AUDIT_ACTION_GROUPS.map((g) => g.label)).toContain("groupEmergency");
  });

  it("resolves entry names with the session user's AAD", async () => {
    const enc = await encryptData(
      JSON.stringify({ title: "Mail" }),
      encryptionKey,
      buildPersonalEntryAAD("u1", "e1", VAULT_TYPE.OVERVIEW),
    );
    mockFetchApi.mockImplementation(async () => json({ items: [], entryOverviews: { e1: { ...enc, aadVersion: 1 } } }));
    const { result } = renderHook(() => usePersonalAuditLogs());

    await waitFor(() => expect(result.current.entryNames.get("e1")).toBe("Mail"));
    const label = result.current.getTargetLabel(
      item(AUDIT_ACTION.ENTRY_UPDATE, { targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY, targetId: "e1" }),
    );
    expect(label).toBe("Mail");
  });

  it("resolves no entry names without a session user", async () => {
    mockUseSession.mockReturnValue({ data: null });
    const enc = await encryptData(JSON.stringify({ title: "Mail" }), encryptionKey);
    mockFetchApi.mockImplementation(async () => json({ items: [], entryOverviews: { e1: { ...enc, aadVersion: 0 } } }));
    const { result } = renderHook(() => usePersonalAuditLogs());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entryNames.size).toBe(0);
  });

  it("returns null for an action without a target detail", async () => {
    mockFetchApi.mockImplementation(async () => json({ items: [] }));
    const { result } = renderHook(() => usePersonalAuditLogs());

    expect(result.current.getTargetLabel(item(AUDIT_ACTION.AUTH_LOGOUT))).toBeNull();
    expect(result.current.getTargetLabel(item(AUDIT_ACTION.AUTH_LOGIN, { metadata: { provider: "x" } }))).toBe(
      'providerMeta({"provider":"x"})',
    );
  });

  it("ignores a non-numeric unlock-attempt count", async () => {
    mockFetchApi.mockImplementation(async () => json({ items: [] }));
    const { result } = renderHook(() => usePersonalAuditLogs());

    expect(
      result.current.getTargetLabel(item(AUDIT_ACTION.VAULT_UNLOCK_FAILED, { metadata: { attempts: "3" } })),
    ).toBeNull();
    expect(
      result.current.getTargetLabel(item(AUDIT_ACTION.VAULT_UNLOCK_FAILED, { metadata: { attempts: 3 } })),
    ).toBe('attemptsMeta({"attempts":3})');
  });

  it("returns null emergency detail for a non-emergency action", async () => {
    mockFetchApi.mockImplementation(async () => json({ items: [] }));
    const { result } = renderHook(() => usePersonalAuditLogs());

    expect(result.current.getEmergencyDetail(item(AUDIT_ACTION.AUTH_LOGIN))).toBeNull();
    expect(result.current.getEmergencyDetail(item(AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE))).toBe(
      'eaAccessRevokedFor({"user":"unknownUser"})',
    );
  });

  it("prefers a related user's name over the fallback email", async () => {
    mockFetchApi.mockResolvedValue(
      json({ items: [], relatedUsers: { g: { id: "g", name: "Gina", email: "g@example.com", image: null } } }),
    );
    const { result } = renderHook(() => usePersonalAuditLogs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const detail = result.current.getEmergencyDetail(
      item(AUDIT_ACTION.EMERGENCY_GRANT_CREATE, { metadata: { granteeId: "g", granteeEmail: "other@example.com" } }),
    );
    expect(detail).toBe('eaGrantCreatedFor({"user":"Gina"})');
  });
});
