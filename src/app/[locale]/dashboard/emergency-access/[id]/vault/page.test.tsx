// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { VAULT_STATUS } from "@/lib/constants";
import { deriveEncryptionKey } from "@/lib/crypto/crypto-client";
import {
  buildEmergencyVaultFixture,
  EMERGENCY_GRANT_ID,
  type EmergencyEntrySpec,
  type EmergencyVaultFixture,
} from "@/__tests__/helpers/emergency-vault-fixtures";

type CardProps = {
  entry: { id: string; title: string; username: string | null; requireReprompt: boolean };
  expanded: boolean;
  readOnly?: boolean;
  canEdit: boolean;
  onToggleExpand: (id: string) => void;
  getPassword?: () => Promise<string>;
  getDetail?: () => Promise<Record<string, unknown>>;
  getUrl?: () => Promise<string | null>;
};

const { mockFetchApi, mockUseVault, mockPush, cardProps } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseVault: vi.fn(),
  mockPush: vi.fn(),
  cardProps: new Map<string, CardProps>(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${JSON.stringify(values)})` : key,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "grant-1" }),
}));
vi.mock("@/i18n/navigation", async () => {
  const { mockI18nNavigation } = await import("@/__tests__/helpers/mock-app-navigation");
  return mockI18nNavigation({ router: { push: mockPush } });
});
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mockUseVault }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));
vi.mock("@/components/passwords/detail/password-card", () => ({
  PasswordCard: (props: CardProps) => {
    cardProps.set(props.entry.id, props);
    return (
      <div data-testid={`card-${props.entry.id}`} data-expanded={String(props.expanded)}>
        {props.entry.title}
        <button type="button" onClick={() => props.onToggleExpand(props.entry.id)}>
          toggle-{props.entry.id}
        </button>
      </div>
    );
  },
}));

import EmergencyVaultPage from "./page";

const LOGIN: EmergencyEntrySpec = {
  id: "e1",
  overview: { title: "Bank", username: "alice", urlHost: "bank.example", tags: [] },
  blob: { title: "Bank", password: "s3cret", url: "https://bank.example", notes: "n", passwordHistory: [] },
};
const LEGACY: EmergencyEntrySpec = {
  id: "e2",
  aadVersion: 0,
  overview: { title: "", tags: [] },
  blob: { title: "" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function serve(fx: EmergencyVaultFixture, opts: { vaultStatus?: number; entriesStatus?: number } = {}) {
  mockFetchApi.mockImplementation(async (path: string) => {
    if (path.endsWith("/vault/entries")) return json(fx.entriesBody, opts.entriesStatus ?? 200);
    if (path.endsWith("/vault")) {
      return opts.vaultStatus ? json({ error: "NOT_FOUND" }, opts.vaultStatus) : json(fx.vaultBody);
    }
    throw new Error(`unexpected ${path}`);
  });
  mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: fx.granteeEncryptionKey });
}

describe("EmergencyVaultPage", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    cardProps.clear();
  });

  it("asks to unlock and fetches nothing while the vault is locked", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.LOCKED, encryptionKey: null });
    render(<EmergencyVaultPage />);

    expect(screen.getByText("vaultUnlockRequired")).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("surfaces the unlock notice when unlocked without a key", () => {
    mockUseVault.mockReturnValue({ status: VAULT_STATUS.UNLOCKED, encryptionKey: null });
    render(<EmergencyVaultPage />);

    expect(screen.getByText("vaultUnlockRequired")).toBeInTheDocument();
    expect(screen.getByText("readOnlyVault")).toBeInTheDocument();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it("decrypts the grantor's entries through the ECDH unwrap and lists them", async () => {
    const fx = await buildEmergencyVaultFixture([LOGIN]);
    serve(fx);
    render(<EmergencyVaultPage />);

    expect(await screen.findByText("Bank")).toBeInTheDocument();
    expect(screen.getByText('readOnlyVaultDesc({"ownerName":"Alice"})')).toBeInTheDocument();
    expect(mockFetchApi).toHaveBeenCalledWith(`/api/emergency-access/${EMERGENCY_GRANT_ID}/vault`);
    const props = cardProps.get("e1");
    expect(props?.entry).toMatchObject({ username: "alice", requireReprompt: false });
    expect(props?.readOnly).toBe(true);
    expect(props?.canEdit).toBe(false);
  });

  it("falls back to the owner's email when the owner has no name", async () => {
    const fx = await buildEmergencyVaultFixture([LOGIN], { name: null, email: "alice@example.com" });
    serve(fx);
    render(<EmergencyVaultPage />);

    expect(await screen.findByText('readOnlyVaultDesc({"ownerName":"alice@example.com"})')).toBeInTheDocument();
  });

  it("titles a legacy entry with an empty title as Untitled", async () => {
    const fx = await buildEmergencyVaultFixture([LEGACY]);
    serve(fx);
    render(<EmergencyVaultPage />);

    expect(await screen.findByText("Untitled")).toBeInTheDocument();
  });

  it("decrypts the password, url and detail on demand", async () => {
    const fx = await buildEmergencyVaultFixture([LOGIN]);
    serve(fx);
    render(<EmergencyVaultPage />);
    await screen.findByText("Bank");
    const props = cardProps.get("e1");

    await expect(props?.getPassword?.()).resolves.toBe("s3cret");
    await expect(props?.getUrl?.()).resolves.toBe("https://bank.example");
    await expect(props?.getDetail?.()).resolves.toMatchObject({
      id: "e1",
      password: "s3cret",
      notes: "n",
      urlHost: "bank.example",
      requireReprompt: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("counts entries whose overview fails to decrypt and lists the rest", async () => {
    const fx = await buildEmergencyVaultFixture([LOGIN, { ...LEGACY, id: "bad", corruptOverview: true }]);
    serve(fx);
    render(<EmergencyVaultPage />);

    expect(await screen.findByText('decryptFailWarning({"count":"1"})')).toBeInTheDocument();
    expect(screen.getByText("Bank")).toBeInTheDocument();
    expect(cardProps.has("bad")).toBe(false);
  });

  it("refuses to decrypt with a different grantee key", async () => {
    const fx = await buildEmergencyVaultFixture([LOGIN]);
    serve(fx);
    mockUseVault.mockReturnValue({
      status: VAULT_STATUS.UNLOCKED,
      encryptionKey: await deriveEncryptionKey(new Uint8Array(32).fill(0x99)),
    });
    render(<EmergencyVaultPage />);

    expect(await screen.findByText("networkError")).toBeInTheDocument();
    expect(screen.queryByText("Bank")).toBeNull();
  });

  it("shows the mapped error when the vault request is refused", async () => {
    const fx = await buildEmergencyVaultFixture([]);
    serve(fx, { vaultStatus: 404 });
    render(<EmergencyVaultPage />);

    expect(await screen.findByText("grantNotFound")).toBeInTheDocument();
  });

  it("shows the network error when the entries request fails", async () => {
    const fx = await buildEmergencyVaultFixture([LOGIN]);
    serve(fx, { entriesStatus: 500 });
    render(<EmergencyVaultPage />);

    expect(await screen.findByText("networkError")).toBeInTheDocument();
  });

  it("shows the empty state when the grantor has no entries", async () => {
    const fx = await buildEmergencyVaultFixture([]);
    serve(fx);
    render(<EmergencyVaultPage />);

    expect(await screen.findByText("noEntries")).toBeInTheDocument();
  });

  it("toggles a card's expanded state", async () => {
    const fx = await buildEmergencyVaultFixture([LOGIN]);
    serve(fx);
    render(<EmergencyVaultPage />);
    await screen.findByText("Bank");

    fireEvent.click(screen.getByRole("button", { name: "toggle-e1" }));
    expect(screen.getByTestId("card-e1")).toHaveAttribute("data-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "toggle-e1" }));
    expect(screen.getByTestId("card-e1")).toHaveAttribute("data-expanded", "false");
  });

  it("navigates back to the emergency-access page", async () => {
    const fx = await buildEmergencyVaultFixture([]);
    serve(fx);
    render(<EmergencyVaultPage />);
    await screen.findByText("noEntries");

    const back = screen.getAllByRole("button")[0];
    fireEvent.click(back);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/dashboard/emergency-access"));
  });
});
