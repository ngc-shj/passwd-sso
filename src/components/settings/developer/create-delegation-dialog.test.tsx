// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockToast, mockUseVault, mockDecryptData } = vi.hoisted(
  () => ({
    mockFetch: vi.fn(),
    mockToast: { success: vi.fn(), error: vi.fn() },
    mockUseVault: vi.fn(),
    mockDecryptData: vi.fn(),
  }),
);

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => mockUseVault(),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  decryptData: (...args: unknown[]) => mockDecryptData(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildPersonalEntryAAD: (userId: string, entryId: string, vaultType: string) =>
    `aad:${userId}:${entryId}:${vaultType}`,
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

// Select is replaced by option buttons so a token / TTL can be picked in jsdom;
// the "open-select" button stands in for the dropdown opening.
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const SelectCtx = createContext<(v: string) => void>(() => {});
  return {
    Select: ({
      children,
      onValueChange,
      onOpenChange,
    }: {
      children: ReactNode;
      onValueChange: (v: string) => void;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <SelectCtx.Provider value={onValueChange}>
        <div>
          {onOpenChange && (
            <button type="button" onClick={() => onOpenChange(true)}>
              open-select
            </button>
          )}
          {children}
        </div>
      </SelectCtx.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: function SelectItem({
      children,
      value,
      disabled,
    }: {
      children: ReactNode;
      value: string;
      disabled?: boolean;
    }) {
      const pick = useContext(SelectCtx);
      return (
        <button type="button" role="option" aria-selected={false} disabled={disabled} onClick={() => pick(value)}>
          {children}
        </button>
      );
    },
  };
});

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: () => void;
  }) => <input type="checkbox" checked={checked} onChange={() => onCheckedChange()} />,
}));

import { CreateDelegationDialog } from "./create-delegation-dialog";

describe("CreateDelegationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVault.mockReturnValue({
      encryptionKey: new Uint8Array(32),
      userId: "user-1",
    });
  });

  it("does not render dialog content when open=false", () => {
    render(
      <CreateDelegationDialog
        open={false}
        onOpenChange={vi.fn()}
        availableTokens={[]}
        onCreated={vi.fn()}
      />,
    );
    // Title shouldn't be in DOM since dialog is closed
    expect(screen.queryByText("newDelegation")).toBeNull();
  });

  it("R26: shows no-decrypt-scope warning when no decryptable tokens are available", () => {
    render(
      <CreateDelegationDialog
        open={true}
        onOpenChange={vi.fn()}
        availableTokens={[
          {
            id: "t1",
            mcpClientName: "Claude",
            mcpClientId: "client-1",
            hasDelegationScope: false,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ]}
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByText("noDecryptScope")).toBeInTheDocument();
  });

  it("R26: confirm button is disabled when no entries selected", () => {
    render(
      <CreateDelegationDialog
        open={true}
        onOpenChange={vi.fn()}
        availableTokens={[
          {
            id: "t1",
            mcpClientName: "Claude",
            mcpClientId: "client-1",
            hasDelegationScope: true,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ]}
        onCreated={vi.fn()}
      />,
    );
    const confirm = screen.getByRole("button", { name: /^confirm$/ });
    expect(confirm).toBeDisabled();
  });
});

const TOKEN = {
  id: "t1",
  mcpClientName: "Claude",
  mcpClientId: "client-1",
  hasDelegationScope: true,
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
};

interface RawEntry {
  id: string;
  aadVersion: number;
  overview: { title: string; username?: string | null; urlHost?: string | null } | null;
}

function listResponse(entries: RawEntry[]): Response {
  return new Response(
    JSON.stringify(
      entries.map((e) => ({ id: e.id, aadVersion: e.aadVersion, encryptedOverview: { tag: e.id } })),
    ),
    { status: 200 },
  );
}

// decryptData resolves to the overview keyed by the ciphertext tag; a null overview throws.
function decryptFrom(entries: RawEntry[]) {
  mockDecryptData.mockImplementation((enc: { tag: string }) => {
    const entry = entries.find((e) => e.id === enc.tag);
    if (!entry?.overview) return Promise.reject(new Error("bad key"));
    return Promise.resolve(JSON.stringify(entry.overview));
  });
}

function renderDialog(
  overrides: Partial<{
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
    tokens: typeof TOKEN[];
  }> = {},
) {
  const props = {
    onOpenChange: overrides.onOpenChange ?? vi.fn(),
    onCreated: overrides.onCreated ?? vi.fn(),
    availableTokens: overrides.tokens ?? [TOKEN],
  };
  const utils = render(<CreateDelegationDialog open={true} {...props} />);
  return { ...utils, props };
}

function pickToken(name: RegExp = /Claude/) {
  fireEvent.click(screen.getByRole("option", { name }));
}

function entryCheckbox(title: string) {
  return screen.getByRole("checkbox", { name: new RegExp(title) });
}

function delegationPosts() {
  return mockFetch.mock.calls.filter((c) => c[0] === "/api/vault/delegation");
}

const ENTRIES: RawEntry[] = [
  { id: "e-z", aadVersion: 1, overview: { title: "Zulu", username: "zed" } },
  { id: "e-a", aadVersion: 0, overview: { title: "Alpha", username: "alice", urlHost: "a.example" } },
  { id: "e-bad", aadVersion: 1, overview: null },
];

describe("CreateDelegationDialog entry loading and submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVault.mockReturnValue({ encryptionKey: new Uint8Array(32), userId: "user-1" });
  });

  it("does not load entries until a token is selected", () => {
    renderDialog();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("selectEntries")).not.toBeInTheDocument();
  });

  it("lists decrypted entries sorted by title, skipping ones that fail to decrypt", async () => {
    decryptFrom(ENTRIES);
    mockFetch.mockResolvedValueOnce(listResponse(ENTRIES));
    renderDialog();
    pickToken();

    await screen.findByText("Alpha");
    expect(mockFetch).toHaveBeenCalledWith("/api/passwords");
    const titles = screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent);
    expect(titles).toEqual(["Alphaalice", "Zuluzed"]);
  });

  it("binds AAD for entries with aadVersion>=1 and omits it for legacy entries", async () => {
    decryptFrom(ENTRIES);
    mockFetch.mockResolvedValueOnce(listResponse(ENTRIES));
    renderDialog();
    pickToken();
    await screen.findByText("Alpha");

    const aadFor = (id: string) =>
      mockDecryptData.mock.calls.find((c) => (c[0] as { tag: string }).tag === id)?.[2];
    expect(aadFor("e-z")).toBe("aad:user-1:e-z:overview");
    expect(aadFor("e-a")).toBeUndefined();
  });

  it("does not fetch when the vault is locked", () => {
    mockUseVault.mockReturnValue({ encryptionKey: null, userId: "user-1" });
    renderDialog();
    pickToken();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("retries the entry load when another token is picked after a failed load", async () => {
    const second = { ...TOKEN, id: "t2", mcpClientName: "Cursor" };
    decryptFrom(ENTRIES);
    mockFetch
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(listResponse(ENTRIES));
    renderDialog({ tokens: [TOKEN, second] });

    pickToken(/Claude/);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();

    pickToken(/Cursor/);
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("filters entries by title or username, case-insensitively", async () => {
    decryptFrom(ENTRIES);
    mockFetch.mockResolvedValueOnce(listResponse(ENTRIES));
    renderDialog();
    pickToken();
    await screen.findByText("Alpha");

    fireEvent.change(screen.getByPlaceholderText("selectEntries"), { target: { value: "ZED" } });
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Zulu")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("selectEntries"), { target: { value: "alp" } });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByText("Zulu")).not.toBeInTheDocument();
  });

  it("toggling an entry updates the counter, warning and confirm state", async () => {
    decryptFrom(ENTRIES);
    mockFetch.mockResolvedValueOnce(listResponse(ENTRIES));
    renderDialog();
    pickToken();
    await screen.findByText("Alpha");
    const confirm = screen.getByRole("button", { name: /^confirm$/ });

    fireEvent.click(entryCheckbox("Alpha"));
    expect(screen.getByText("1/20")).toBeInTheDocument();
    expect(screen.getByText("warning")).toBeInTheDocument();
    expect(confirm).toBeEnabled();

    fireEvent.click(entryCheckbox("Alpha"));
    expect(screen.getByText("0/20")).toBeInTheDocument();
    expect(screen.queryByText("warning")).not.toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it("caps the selection at 20 entries", async () => {
    const many: RawEntry[] = Array.from({ length: 21 }, (_, i) => ({
      id: `e${i}`,
      aadVersion: 1,
      overview: { title: `Entry ${String(i).padStart(2, "0")}` },
    }));
    decryptFrom(many);
    mockFetch.mockResolvedValueOnce(listResponse(many));
    renderDialog();
    pickToken();
    await screen.findByText("Entry 00");

    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    expect(screen.getByText("20/20")).toBeInTheDocument();
    expect(entryCheckbox("Entry 20")).not.toBeChecked();
  });

  it("posts the token, chosen TTL and metadata-only entries, then closes and notifies", async () => {
    decryptFrom(ENTRIES);
    mockFetch
      .mockResolvedValueOnce(listResponse(ENTRIES))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    const { props } = renderDialog();
    pickToken();
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("option", { name: 'ttlMinutes:{"minutes":"5"}' }));
    fireEvent.click(entryCheckbox("Alpha"));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/ }));

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledTimes(1));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(mockToast.success).toHaveBeenCalledWith("created");
    const init = delegationPosts()[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      mcpTokenId: "t1",
      ttlSeconds: 300,
      entries: [{ id: "e-a", title: "Alpha", username: "alice", urlHost: "a.example" }],
    });
  });

  it("toasts the translated error code, never the server's message, when the delegation is refused", async () => {
    decryptFrom(ENTRIES);
    mockFetch
      .mockResolvedValueOnce(listResponse(ENTRIES))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "VALIDATION_ERROR", details: { message: "Too many entries" } }),
          { status: 400 },
        ),
      );
    const { props } = renderDialog();
    pickToken();
    await screen.findByText("Alpha");
    fireEvent.click(entryCheckbox("Zulu"));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/ }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("validationError"));
    // details.message is an untranslated server string.
    expect(mockToast.error).not.toHaveBeenCalledWith("Too many entries");
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("translates a refusal without a message from its error code", async () => {
    decryptFrom(ENTRIES);
    mockFetch
      .mockResolvedValueOnce(listResponse(ENTRIES))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }));
    renderDialog();
    pickToken();
    await screen.findByText("Alpha");
    fireEvent.click(entryCheckbox("Zulu"));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/ }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("forbidden"));
  });

  it("falls back to the unknown error when the refusal carries no code", async () => {
    decryptFrom(ENTRIES);
    mockFetch
      .mockResolvedValueOnce(listResponse(ENTRIES))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }));
    renderDialog();
    pickToken();
    await screen.findByText("Alpha");
    fireEvent.click(entryCheckbox("Zulu"));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/ }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("unknownError"));
  });

  it("re-enables confirm after the delegation request throws", async () => {
    decryptFrom(ENTRIES);
    mockFetch
      .mockResolvedValueOnce(listResponse(ENTRIES))
      .mockRejectedValueOnce(new Error("network"));
    renderDialog();
    pickToken();
    await screen.findByText("Alpha");
    fireEvent.click(entryCheckbox("Zulu"));
    const confirm = screen.getByRole("button", { name: /^confirm$/ });
    fireEvent.click(confirm);

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("createFailed"));
    expect(confirm).toBeEnabled();
  });

  it("resets the token, entries and selection when the dialog is closed and reopened", async () => {
    decryptFrom(ENTRIES);
    mockFetch.mockResolvedValueOnce(listResponse(ENTRIES));
    const { rerender, props } = renderDialog();
    pickToken();
    await screen.findByText("Alpha");
    fireEvent.click(entryCheckbox("Alpha"));

    rerender(<CreateDelegationDialog open={false} {...props} />);
    rerender(<CreateDelegationDialog open={true} {...props} />);
    expect(screen.queryByPlaceholderText("selectEntries")).not.toBeInTheDocument();
    expect(screen.queryByText("warning")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^confirm$/ })).toBeDisabled();
  });
});

describe("CreateDelegationDialog token expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseVault.mockReturnValue({ encryptionKey: new Uint8Array(32), userId: "user-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disables and labels an already-expired token", () => {
    renderDialog({
      tokens: [{ ...TOKEN, expiresAt: new Date(Date.now() - 60_000).toISOString() }],
    });
    const option = screen.getByRole("option", { name: /Claude/ });
    expect(option).toBeDisabled();
    expect(within(option).getByText("expired")).toBeInTheDocument();
  });

  it("recomputes remaining minutes when the token dropdown is opened", () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    renderDialog({
      tokens: [{ ...TOKEN, expiresAt: "2026-01-01T00:10:00Z" }],
    });
    expect(screen.getByRole("option", { name: /Claude/ })).toHaveTextContent('expiresIn:{"minutes":10}');

    vi.setSystemTime(new Date("2026-01-01T00:11:00Z"));
    fireEvent.click(screen.getAllByRole("button", { name: "open-select" })[0]);
    const option = screen.getByRole("option", { name: /Claude/ });
    expect(option).toHaveTextContent("expired");
    expect(option).toBeDisabled();
  });
});
