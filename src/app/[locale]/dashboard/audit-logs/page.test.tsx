// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { API_PATH, AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { deriveEncryptionKey, encryptData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";

const { mockFetchApi, mockUseVault, mockUseSession } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
  mockUseSession: vi.fn(),
}));

vi.mock("next-intl", async () => {
  const { mockTranslator: mt } = await import("@/__tests__/helpers/mock-translator");
  return {
    useTranslations: () =>
      mt((key: string, values?: Record<string, unknown>) =>
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

import AuditLogsPage from "./page";

const USER_ID = "user-1";
// Test-only vault key.
let encryptionKey: CryptoKey;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function log(action: string, extra: Record<string, unknown> = {}) {
  return {
    id: `log-${action}-${Math.random()}`,
    action,
    actorType: "HUMAN",
    userId: USER_ID,
    targetType: null,
    targetId: null,
    metadata: null,
    ip: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    user: { id: USER_ID, name: "Viewer", email: "v@example.com" },
    ...extra,
  };
}

function serveLogs(items: unknown[], extra: Record<string, unknown> = {}) {
  mockFetchApi.mockImplementation(async () => json({ items, nextCursor: null, ...extra }));
}

async function overviewFor(entryId: string, title: string, aadVersion: number) {
  const aad = aadVersion >= 1 ? buildPersonalEntryAAD(USER_ID, entryId, VAULT_TYPE.OVERVIEW) : undefined;
  const enc = await encryptData(JSON.stringify({ title }), encryptionKey, aad);
  return { ...enc, aadVersion };
}

const entryLog = (id: string) =>
  log(AUDIT_ACTION.ENTRY_UPDATE, { targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY, targetId: id });

describe("AuditLogsPage", () => {
  beforeEach(async () => {
    mockFetchApi.mockReset();
    encryptionKey = await deriveEncryptionKey(new Uint8Array(32).fill(0x42));
    mockUseVault.mockReturnValue({ encryptionKey });
    mockUseSession.mockReturnValue({ data: { user: { id: USER_ID } } });
  });

  it("fetches the personal audit-log endpoint", async () => {
    serveLogs([]);
    render(<AuditLogsPage />);

    expect(await screen.findByText("noLogs")).toBeInTheDocument();
    expect(String(mockFetchApi.mock.calls[0][0])).toMatch(new RegExp(`^${API_PATH.AUDIT_LOGS}\\?`));
  });

  it("shows the entry title decrypted from an AAD-bound overview", async () => {
    serveLogs([entryLog("e1")], { entryOverviews: { e1: await overviewFor("e1", "Bank login", 1) } });
    render(<AuditLogsPage />);

    expect(await screen.findByText("Bank login")).toBeInTheDocument();
  });

  it("shows the entry title decrypted from a legacy overview without AAD", async () => {
    serveLogs([entryLog("e2")], { entryOverviews: { e2: await overviewFor("e2", "Old entry", 0) } });
    render(<AuditLogsPage />);

    expect(await screen.findByText("Old entry")).toBeInTheDocument();
  });

  it("falls back to deleted-entry when an overview does not decrypt", async () => {
    // AAD-bound to another entry id, so the decrypt for e3 fails.
    const wrongAad = await overviewFor("other", "Secret", 1);
    serveLogs([entryLog("e3")], { entryOverviews: { e3: wrongAad } });
    render(<AuditLogsPage />);

    expect(await screen.findByText("deletedEntry")).toBeInTheDocument();
    expect(screen.queryByText("Secret")).toBeNull();
  });

  it("does not decrypt entry names while the vault is locked", async () => {
    mockUseVault.mockReturnValue({ encryptionKey: null });
    serveLogs([entryLog("e1")], { entryOverviews: { e1: await overviewFor("e1", "Bank login", 1) } });
    render(<AuditLogsPage />);

    expect(await screen.findByText("deletedEntry")).toBeInTheDocument();
    expect(screen.queryByText("Bank login")).toBeNull();
  });

  it.each([
    [log(AUDIT_ACTION.AUTH_LOGIN, { metadata: { provider: "google" } }), 'providerMeta({"provider":"google"})'],
    [log(AUDIT_ACTION.VAULT_UNLOCK_FAILED, { metadata: { attempts: 3 } }), 'attemptsMeta({"attempts":3})'],
    [log(AUDIT_ACTION.VAULT_LOCKOUT_TRIGGERED, { metadata: { attempts: 5, lockMinutes: 15 } }), 'lockoutMeta({"attempts":5,"lockMinutes":15})'],
    [log(AUDIT_ACTION.VAULT_LOCKOUT_TRIGGERED, { metadata: {} }), 'lockoutMeta({"attempts":0,"lockMinutes":0})'],
    [log(AUDIT_ACTION.SESSION_REVOKE_ALL, { metadata: { revokedCount: 4 } }), 'revokedSessionsMeta({"revokedCount":4})'],
    [log(AUDIT_ACTION.VAULT_RESET_EXECUTED, { metadata: { deletedEntries: 7, deletedAttachments: 2 } }), 'vaultResetMeta({"deletedEntries":7,"deletedAttachments":2})'],
    [log(AUDIT_ACTION.VAULT_RESET_EXECUTED, { metadata: {} }), 'vaultResetMeta({"deletedEntries":0,"deletedAttachments":0})'],
    [log(AUDIT_ACTION.DELEGATION_CREATE, { metadata: { entryCount: 2 } }), 'delegationCreateMeta({"entryCount":2})'],
  ])("renders the target detail for %#", async (item, expected) => {
    serveLogs([item]);
    render(<AuditLogsPage />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it("renders no target detail for an AUTH_LOGIN without a provider", async () => {
    serveLogs([log(AUDIT_ACTION.AUTH_LOGIN, { metadata: { other: 1 } })]);
    render(<AuditLogsPage />);

    await screen.findByTestId("audit-log-row");
    expect(screen.queryByText(/providerMeta/)).toBeNull();
  });

  describe("emergency-access detail", () => {
    const related = {
      owner: { id: "owner", name: "Olivia", email: "o@example.com", image: null },
      grantee: { id: "grantee", name: "Gus", email: "g@example.com", image: null },
    };
    const meta = { ownerId: "owner", granteeId: "grantee" };

    it.each([
      [AUDIT_ACTION.EMERGENCY_GRANT_CREATE, 'eaGrantCreatedFor({"user":"Gus"})'],
      [AUDIT_ACTION.EMERGENCY_GRANT_ACCEPT, 'eaGrantAcceptedBy({"viewer":"Viewer","owner":"Olivia"})'],
      [AUDIT_ACTION.EMERGENCY_GRANT_REJECT, 'eaGrantRejectedBy({"viewer":"Viewer","owner":"Olivia"})'],
      [AUDIT_ACTION.EMERGENCY_GRANT_CONFIRM, 'eaGrantConfirmedFor({"user":"Gus"})'],
      [AUDIT_ACTION.EMERGENCY_ACCESS_REQUEST, 'eaAccessRequestedBy({"viewer":"Viewer","owner":"Olivia"})'],
      [AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE, 'eaAccessActivatedFor({"user":"Gus"})'],
      [AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE, 'eaAccessRevokedFor({"user":"Gus"})'],
      [AUDIT_ACTION.EMERGENCY_VAULT_ACCESS, 'viewedByOwner({"viewer":"Viewer","owner":"Olivia"})'],
    ])("describes %s with the related users", async (action, expected) => {
      serveLogs([log(action, { metadata: meta })], { relatedUsers: related });
      render(<AuditLogsPage />);

      expect(await screen.findByText(expected)).toBeInTheDocument();
    });

    it("appends the entry count to a vault-access detail", async () => {
      serveLogs([log(AUDIT_ACTION.EMERGENCY_VAULT_ACCESS, { metadata: { ...meta, entryCount: 9 } })], {
        relatedUsers: related,
      });
      render(<AuditLogsPage />);

      expect(
        await screen.findByText('viewedByOwner({"viewer":"Viewer","owner":"Olivia"}) — eaVaultAccessMeta({"entryCount":9})'),
      ).toBeInTheDocument();
    });

    it("names the owner for an activation without a grantee id", async () => {
      serveLogs([log(AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE, { metadata: { ownerId: "owner" } })], {
        relatedUsers: related,
      });
      render(<AuditLogsPage />);

      expect(await screen.findByText('eaAccessActivatedFor({"user":"Olivia"})')).toBeInTheDocument();
    });

    it("falls back to the grantee email, then unknown-user", async () => {
      serveLogs([
        log(AUDIT_ACTION.EMERGENCY_GRANT_CREATE, { metadata: { granteeEmail: "new@example.com" } }),
        log(AUDIT_ACTION.EMERGENCY_GRANT_ACCEPT, { metadata: null, user: null }),
      ]);
      render(<AuditLogsPage />);

      expect(await screen.findByText('eaGrantCreatedFor({"user":"new@example.com"})')).toBeInTheDocument();
      expect(
        screen.getByText('eaGrantAcceptedBy({"viewer":"unknownUser","owner":"unknownUser"})'),
      ).toBeInTheDocument();
    });
  });

  it("loads the next page with the cursor and merges its related users", async () => {
    const first = log(AUDIT_ACTION.EMERGENCY_GRANT_CREATE, { metadata: { granteeId: "g1" } });
    const second = log(AUDIT_ACTION.EMERGENCY_GRANT_CONFIRM, { metadata: { granteeId: "g2" } });
    mockFetchApi
      .mockResolvedValueOnce(
        json({ items: [first], nextCursor: "c1", relatedUsers: { g1: { id: "g1", name: "One", email: null, image: null } } }),
      )
      .mockResolvedValueOnce(
        json({ items: [second], nextCursor: null, relatedUsers: { g2: { id: "g2", name: "Two", email: null, image: null } } }),
      );
    render(<AuditLogsPage />);
    await screen.findByText('eaGrantCreatedFor({"user":"One"})');

    fireEvent.click(screen.getByRole("button", { name: "loadMore" }));

    expect(await screen.findByText('eaGrantConfirmedFor({"user":"Two"})')).toBeInTheDocument();
    expect(screen.getByText('eaGrantCreatedFor({"user":"One"})')).toBeInTheDocument();
    await waitFor(() => expect(String(mockFetchApi.mock.calls[1][0])).toContain("cursor=c1"));
  });
});
