// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { UseAuditLogsConfig } from "@/hooks/vault/use-audit-logs";

const { mockFetch, mockDecryptData, captured, teamVault, Pass } = vi.hoisted(() => ({
  Pass: ({ children }: { children?: ReactNode }) => children ?? null,
  mockFetch: vi.fn(),
  mockDecryptData: vi.fn(),
  captured: { config: null as UseAuditLogsConfig | null },
  teamVault: {
    getTeamEncryptionKey: vi.fn(),
    getEntryDecryptionKey: vi.fn(),
  },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/team/team-vault-core", () => ({
  useTeamVaultOptional: () => teamVault,
}));

// The real crypto-team helper runs over this decryptData (plan C5 T8).
vi.mock("@/lib/crypto/crypto-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crypto/crypto-client")>()),
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/hooks/vault/use-audit-logs", () => ({
  useAuditLogs: (config: UseAuditLogsConfig) => {
    captured.config = config;
    return {
      logs: [], loading: false, loadingMore: false, nextCursor: null, entryNames: new Map(),
      actorTypeFilter: "ALL", setActorTypeFilter: vi.fn(), dateFrom: "", dateTo: "",
      setDateFrom: vi.fn(), setDateTo: vi.fn(), downloading: false, handleDownload: vi.fn(),
      handleLoadMore: vi.fn(), formatDate: (d: string) => d, actionLabel: (a: string) => a,
    };
  },
}));

vi.mock("@/components/ui/card", () => ({ Card: Pass, CardContent: Pass }));
vi.mock("@/components/ui/label", () => ({ Label: Pass }));
vi.mock("@/components/ui/select", () => ({
  Select: Pass, SelectContent: Pass, SelectItem: Pass, SelectTrigger: Pass, SelectValue: Pass,
}));
vi.mock("@/components/settings/account/section-card-header", () => ({ SectionCardHeader: () => null }));
vi.mock("@/components/settings/account/section-layout", () => ({ SectionLayout: Pass }));
vi.mock("@/components/audit/audit-action-filter", () => ({ AuditActionFilter: () => null }));
vi.mock("@/components/audit/audit-date-filter", () => ({ AuditDateFilter: () => null }));
vi.mock("@/components/audit/audit-download-button", () => ({ AuditDownloadButton: () => null }));
vi.mock("@/components/audit/audit-log-list", () => ({ AuditLogList: () => null }));

import TeamAdminAuditLogsPage from "./page";
import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
import { aadGatedDecrypt } from "@/__tests__/helpers/aad-model-decrypt";

const TEAM_ID = "team-1";
const ENTRY_ID = "entry-1";

/** A params promise React's `use` reads synchronously. */
function resolvedParams(): Promise<{ teamId: string }> {
  const value = { teamId: TEAM_ID };
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

describe("TeamAdminAuditLogsPage entry names", () => {
  beforeEach(() => {
    captured.config = null;
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: false });
    mockDecryptData.mockReset();
    teamVault.getTeamEncryptionKey.mockResolvedValue({} as CryptoKey);
    teamVault.getEntryDecryptionKey.mockResolvedValue({} as CryptoKey);
  });

  // T8: an entry's title opens at the overview vaultType and its own ItemKey version.
  it.each([
    ["control: names an entry whose overview is sealed at overview / its ItemKey version", "overview", 3, "Title"],
    ["does not name an entry whose overview is sealed at the blob vaultType", "blob", 3, undefined],
    ["does not name an entry whose overview is sealed at another ItemKey version", "overview", 2, undefined],
  ] as const)("%s (T8)", async (_label, vaultType, sealedVersion, title) => {
    mockDecryptData.mockImplementation(
      aadGatedDecrypt(buildTeamEntryAAD(TEAM_ID, ENTRY_ID, vaultType, sealedVersion), JSON.stringify({ title: "Title" })),
    );
    render(<TeamAdminAuditLogsPage params={resolvedParams()} />);
    const resolve = captured.config?.resolveEntryNames;
    if (!resolve) throw new Error("useAuditLogs was not given resolveEntryNames");

    const names = await resolve({
      entryOverviews: {
        [ENTRY_ID]: {
          encryptedOverview: "ct", overviewIv: "iv", overviewAuthTag: "tag", aadVersion: 1, teamKeyVersion: 1,
          encryptedItemKey: "ek", itemKeyIv: "ekiv", itemKeyAuthTag: "ektag", itemKeyVersion: 3, itemKeyId: "ik",
        },
      },
    });

    expect(names.get(ENTRY_ID)).toBe(title);
    expect(mockDecryptData).toHaveBeenCalledTimes(1);
  });
});
