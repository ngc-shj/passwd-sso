// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const { mockFetch, mockToast, mockCanUsePasskeyRecovery, mockReauthenticateWithPasskey } =
  vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockToast: { success: vi.fn(), error: vi.fn() },
    mockCanUsePasskeyRecovery: vi.fn(),
    mockReauthenticateWithPasskey: vi.fn(),
  }));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/format/format-datetime", () => ({
  formatDateTime: (d: string) => d,
  formatRelativeTime: (d: string) => d,
}));

import "@/__tests__/helpers/passkey-reauth-mocks";

vi.mock("@/lib/auth/webauthn/can-use-passkey-recovery", () => ({
  canUsePasskeyRecovery: mockCanUsePasskeyRecovery,
}));

vi.mock("@/lib/auth/webauthn/passkey-reauth-client", () => ({
  reauthenticateWithPasskey: mockReauthenticateWithPasskey,
}));

// Radix Select cannot be driven in jsdom; options become buttons that call onValueChange.
vi.mock("@/components/ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const SelectCtx = createContext<(v: string) => void>(() => {});
  return {
    Select: ({ children, onValueChange }: { children: ReactNode; onValueChange: (v: string) => void }) => (
      <SelectCtx.Provider value={onValueChange}>
        <div>{children}</div>
      </SelectCtx.Provider>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: function SelectItem({ children, value }: { children: ReactNode; value: string }) {
      const pick = useContext(SelectCtx);
      return (
        <button type="button" role="option" aria-selected={false} onClick={() => pick(value)}>
          {children}
        </button>
      );
    },
  };
});

import { DirectorySyncCard } from "./directory-sync-card";

function setupConfigs(configs: Array<Record<string, unknown>>) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (
      String(url).includes("directory-sync") &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(configs),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });
}

const SAMPLE_CONFIG = {
  id: "cfg-del",
  provider: "AZURE_AD",
  displayName: "DeleteMe",
  enabled: true,
  syncIntervalMinutes: 60,
  status: "IDLE",
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncStats: null,
  nextSyncAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("DirectorySyncCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
    mockReauthenticateWithPasskey.mockResolvedValue({ ok: true });
  });

  it("renders empty state when no configs", async () => {
    setupConfigs([]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("noConfigs")).toBeInTheDocument();
    });
  });

  it("shows refused activations on a sync log row only when there were any", async () => {
    // The operator-visible end of the usersRefused chain. No cell opened the logs
    // sheet, so the conditional render was never evaluated and flipping its
    // predicate left this file green.
    const logRow = (id: string, usersRefused: number) => ({
      id,
      status: "SUCCESS",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      dryRun: false,
      usersCreated: 0,
      usersUpdated: 1,
      usersDeactivated: 0,
      usersRefused,
      groupsUpdated: 0,
      errorMessage: null,
    });
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("logs")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ items: [logRow("log-a", 2), logRow("log-b", 0)], hasMore: false }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([SAMPLE_CONFIG]) });
    });

    const { container } = render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("DeleteMe")).toBeInTheDocument();
    });

    // The logs button is icon-only with no accessible name, so it is found by its
    // icon rather than by role.
    const logsButton = container.querySelector("svg.lucide-scroll-text")?.closest("button");
    if (!logsButton) throw new Error("logs button not rendered");
    fireEvent.click(logsButton);

    // Exactly one: the row with refusals shows the count, the row with none does not.
    await waitFor(() => {
      expect(screen.getAllByText(/^logUsersRefused/)).toHaveLength(1);
    });
    expect(screen.getByText("logUsersRefused: 2")).toBeInTheDocument();
  });

  it("renders a config row with provider/status badges", async () => {
    setupConfigs([
      {
        id: "cfg1",
        provider: "AZURE_AD",
        displayName: "MyAzure",
        enabled: true,
        syncIntervalMinutes: 60,
        status: "IDLE",
        lastSyncAt: null,
        lastSyncError: null,
        lastSyncStats: null,
        nextSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("MyAzure")).toBeInTheDocument();
    });
    expect(screen.getByText("providerAzureAd")).toBeInTheDocument();
    expect(screen.getByText("statusIdle")).toBeInTheDocument();
    expect(screen.getByText(/neverSynced/)).toBeInTheDocument();
  });

  it("renders disabled badge when config is disabled", async () => {
    setupConfigs([
      {
        id: "cfg2",
        provider: "OKTA",
        displayName: "Okta-Disabled",
        enabled: false,
        syncIntervalMinutes: 60,
        status: "IDLE",
        lastSyncAt: null,
        lastSyncError: null,
        lastSyncStats: null,
        nextSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("Okta-Disabled")).toBeInTheDocument();
    });
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("renders the lastSyncError when present", async () => {
    setupConfigs([
      {
        id: "cfg3",
        provider: "GOOGLE_WORKSPACE",
        displayName: "GW-Failed",
        enabled: true,
        syncIntervalMinutes: 60,
        status: "ERROR",
        lastSyncAt: new Date().toISOString(),
        lastSyncError: "auth failure xyz",
        lastSyncStats: null,
        nextSyncAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("GW-Failed")).toBeInTheDocument();
    });
    expect(screen.getByText("auth failure xyz")).toBeInTheDocument();
  });

  // RT8: a stale-session DELETE must surface the reauth recovery path, not the
  // generic syncFailed toast, and must NOT commit the deletion.
  it("opens the recent-session dialog on a SESSION_STEP_UP_REQUIRED delete (RT8)", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url).includes("directory-sync") && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([SAMPLE_CONFIG]),
        });
      }
      if (method === "DELETE") {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ error: "SESSION_STEP_UP_REQUIRED" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });

    render(<DirectorySyncCard />);
    await waitFor(() => {
      expect(screen.getByText("DeleteMe")).toBeInTheDocument();
    });

    // The trash trigger is the last button in the config row; clicking it opens
    // the delete-confirm dialog whose action button is labelled deleteConfig.
    const rowButtons = screen.getAllByRole("button");
    fireEvent.click(rowButtons[rowButtons.length - 1]);

    const confirmBtn = await screen.findByRole("button", { name: "deleteConfig" });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByTestId("recent-session-dialog")).toBeInTheDocument();
    });
    expect(mockToast.success).not.toHaveBeenCalledWith("configDeleted");
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Routes are keyed "METHOD url"; the config list defaults to [SAMPLE_CONFIG].
function route(handlers: Record<string, Handler>, configs: unknown[] = [SAMPLE_CONFIG]) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const handler = handlers[key];
    if (handler) return Promise.resolve(handler(init));
    if (key === "GET /api/directory-sync") return Promise.resolve(jsonRes(configs));
    return Promise.reject(new Error(`unrouted ${key}`));
  });
}

function callsTo(key: string) {
  return mockFetch.mock.calls.filter((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}` === key);
}

function sentBody(key: string): Record<string, unknown> {
  const init = callsTo(key)[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// Labels are not associated with their inputs, so a field is found through its label's wrapper.
function field(labelKey: string): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = within(screen.getByRole("dialog")).getByText(labelKey).closest("div");
  const control = wrapper?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (!control) throw new Error(`no control for ${labelKey}`);
  return control;
}

function type(labelKey: string, value: string) {
  fireEvent.change(field(labelKey), { target: { value } });
}

function saveButton() {
  return within(screen.getByRole("dialog")).getByRole("button", { name: "save" });
}

function iconButton(container: HTMLElement, iconClass: string): HTMLButtonElement {
  const button = container.querySelector(`svg.${iconClass}`)?.closest("button");
  if (!button) throw new Error(`${iconClass} button not rendered`);
  return button;
}

async function renderLoaded() {
  const utils = render(<DirectorySyncCard />);
  await screen.findByText("DeleteMe");
  return utils;
}

async function openCreate() {
  render(<DirectorySyncCard />);
  await screen.findByText("DeleteMe");
  fireEvent.click(screen.getByRole("button", { name: "addConfig" }));
  await screen.findByRole("dialog");
}

function fillAzure() {
  type("displayName", "Corp AD");
  type("azureTenantId", "tid");
  type("azureClientId", "cid");
  type("azureClientSecret", "secret");
}

describe("DirectorySyncCard create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  it("enables save only once a name and every Azure credential are entered", async () => {
    route({});
    await openCreate();
    type("displayName", "Corp AD");
    type("azureTenantId", "tid");
    type("azureClientId", "cid");
    expect(saveButton()).toBeDisabled();
    type("azureClientSecret", "secret");
    expect(saveButton()).toBeEnabled();
  });

  it("posts the provider, settings and credentials, then closes and reloads the list", async () => {
    route({ "POST /api/directory-sync": () => jsonRes({ id: "new" }, 201) });
    await openCreate();
    fillAzure();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: "120" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("switch"));
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("configCreated"));
    expect(sentBody("POST /api/directory-sync")).toEqual({
      provider: "AZURE_AD",
      displayName: "Corp AD",
      enabled: false,
      syncIntervalMinutes: 120,
      credentials: { tenantId: "tid", clientId: "cid", clientSecret: "secret" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsTo("GET /api/directory-sync")).toHaveLength(2);
  });

  it("switching provider clears entered credentials and requires that provider's fields", async () => {
    route({ "POST /api/directory-sync": () => jsonRes({ id: "new" }, 201) });
    await openCreate();
    fillAzure();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: "providerOkta" }));
    expect(saveButton()).toBeDisabled();
    type("oktaOrgUrl", "https://x.okta.com/");
    type("oktaApiToken", "tok");
    fireEvent.click(saveButton());

    await waitFor(() => expect(callsTo("POST /api/directory-sync")).toHaveLength(1));
    const body = sentBody("POST /api/directory-sync");
    expect(body.provider).toBe("OKTA");
    expect(body.credentials).toEqual({ orgUrl: "https://x.okta.com/", apiToken: "tok" });
  });

  it("requires the service account, domain and admin email for Google Workspace", async () => {
    route({});
    await openCreate();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("option", { name: "providerGoogleWorkspace" }),
    );
    type("displayName", "GW");
    type("googleServiceAccount", "{}");
    type("googleDomain", "example.com");
    expect(saveButton()).toBeDisabled();
    type("googleAdminEmail", "admin@example.com");
    expect(saveButton()).toBeEnabled();
  });

  it.each([
    [409, {}, "syncConflict"],
    [400, { error: "VALIDATION_ERROR" }, "validationError"],
    [403, { error: "FORBIDDEN" }, "syncFailed"],
    [500, {}, "syncFailed"],
  ])("maps a %i create response to the %s toast and keeps the dialog open", async (status, body, key) => {
    route({ "POST /api/directory-sync": () => jsonRes(body, status) });
    await openCreate();
    fillAzure();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(key));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("shows a failure toast when the create request throws", async () => {
    route({ "POST /api/directory-sync": () => Promise.reject(new Error("network")) });
    await openCreate();
    fillAzure();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("syncFailed"));
    expect(saveButton()).toBeEnabled();
  });

  it("opens the recent-session dialog when the create needs step-up", async () => {
    route({ "POST /api/directory-sync": () => jsonRes({ error: "SESSION_STEP_UP_REQUIRED" }, 403) });
    await openCreate();
    fillAzure();
    fireEvent.click(saveButton());
    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});

describe("DirectorySyncCard edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  async function openEdit() {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "editConfig" }));
    await screen.findByRole("dialog");
  }

  it("prefills the form, hides the provider choice and waits for a change before saving", async () => {
    route({});
    await openEdit();
    expect(field("displayName")).toHaveValue("DeleteMe");
    expect(within(screen.getByRole("dialog")).queryByRole("option", { name: "providerOkta" })).toBeNull();
    expect(saveButton()).toBeDisabled();
    expect(field("azureClientId")).toHaveAttribute(
      "placeholder",
      "••••••••  (credentialsConfigured)",
    );
    type("displayName", "Renamed");
    expect(saveButton()).toBeEnabled();
  });

  it("PUTs settings without credentials when none were re-entered", async () => {
    route({ "PUT /api/directory-sync/cfg-del": () => jsonRes({}) });
    await openEdit();
    type("displayName", "Renamed");
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("configUpdated"));
    expect(sentBody("PUT /api/directory-sync/cfg-del")).toEqual({
      displayName: "Renamed",
      enabled: true,
      syncIntervalMinutes: 60,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("includes re-entered credentials in the update", async () => {
    route({ "PUT /api/directory-sync/cfg-del": () => jsonRes({}) });
    await openEdit();
    type("displayName", "Renamed");
    type("azureClientSecret", "rotated");
    fireEvent.click(saveButton());
    await waitFor(() => expect(callsTo("PUT /api/directory-sync/cfg-del")).toHaveLength(1));
    expect(sentBody("PUT /api/directory-sync/cfg-del").credentials).toEqual({ clientSecret: "rotated" });
  });

  it.each([
    [400, { error: "VALIDATION_ERROR" }, "validationError"],
    [403, { error: "FORBIDDEN" }, "syncFailed"],
    [500, {}, "syncFailed"],
  ])("maps a %i update response to the %s toast", async (status, body, key) => {
    route({ "PUT /api/directory-sync/cfg-del": () => jsonRes(body, status) });
    await openEdit();
    type("displayName", "Renamed");
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(key));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens the recent-session dialog when the update needs step-up", async () => {
    route({ "PUT /api/directory-sync/cfg-del": () => jsonRes({ error: "SESSION_STEP_UP_REQUIRED" }, 403) });
    await openEdit();
    type("displayName", "Renamed");
    fireEvent.click(saveButton());
    expect(await screen.findByTestId("recent-session-dialog")).toBeInTheDocument();
  });

  it("closes without saving on cancel", async () => {
    route({});
    await openEdit();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsTo("PUT /api/directory-sync/cfg-del")).toHaveLength(0);
  });
});

describe("DirectorySyncCard delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  async function confirmDelete() {
    const { container } = await renderLoaded();
    fireEvent.click(iconButton(container, "lucide-trash-2"));
    fireEvent.click(await screen.findByRole("button", { name: "deleteConfig" }));
  }

  it("deletes the config and reloads the list", async () => {
    route({ "DELETE /api/directory-sync/cfg-del": () => jsonRes({}) });
    await confirmDelete();
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("configDeleted"));
    await waitFor(() => expect(callsTo("GET /api/directory-sync")).toHaveLength(2));
  });

  it.each([
    ["a non-step-up 403", () => jsonRes({ error: "FORBIDDEN" }, 403)],
    ["a 500", () => jsonRes({}, 500)],
    ["a thrown request", () => Promise.reject(new Error("network"))],
  ])("shows the failure toast on %s", async (_label, handler: Handler) => {
    route({ "DELETE /api/directory-sync/cfg-del": handler });
    await confirmDelete();
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("syncFailed"));
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});

describe("DirectorySyncCard run sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  const RUN = "POST /api/directory-sync/cfg-del/run";

  it("starts a non-dry-run sync and reloads the list", async () => {
    route({ [RUN]: () => jsonRes({}) });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "syncNow" }));
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("syncStarted"));
    expect(sentBody(RUN)).toEqual({ dryRun: false, force: false });
    await waitFor(() => expect(callsTo("GET /api/directory-sync")).toHaveLength(2));
  });

  it("disables the sync button while the run is in flight", async () => {
    let finish: (r: Response) => void = () => {};
    route({ [RUN]: () => new Promise<Response>((resolve) => { finish = resolve; }) });
    await renderLoaded();
    const button = screen.getByRole("button", { name: "syncNow" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    finish(jsonRes({}));
    await waitFor(() => expect(button).toBeEnabled());
  });

  it.each([
    ["a 409", () => jsonRes({}, 409), "syncConflict"],
    [
      "a safety-guard abort",
      () => jsonRes({ error: "SYNC_FAILED", details: { abortedSafety: true } }, 422),
      "safetyGuardTriggered",
    ],
    ["a generic failure", () => jsonRes({ error: "SYNC_FAILED" }, 500), "syncFailed"],
    ["a thrown request", () => Promise.reject(new Error("network")), "syncFailed"],
  ])("maps %s to the %s toast", async (_label, handler: Handler, key) => {
    route({ [RUN]: handler });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "syncNow" }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(key));
  });
});

describe("DirectorySyncCard sync logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUsePasskeyRecovery.mockResolvedValue(false);
  });

  const LOGS = "GET /api/directory-sync/cfg-del/logs";
  const log = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    status: "SUCCESS",
    startedAt: `start-${id}`,
    completedAt: null,
    dryRun: false,
    usersCreated: 0,
    usersUpdated: 0,
    usersDeactivated: 0,
    usersRefused: 0,
    groupsUpdated: 0,
    errorMessage: null,
    ...extra,
  });

  async function openLogs() {
    const { container } = await renderLoaded();
    fireEvent.click(iconButton(container, "lucide-scroll-text"));
  }

  it("shows the empty state when the config has no logs", async () => {
    route({ [LOGS]: () => jsonRes({ items: [], hasMore: false }) });
    await openLogs();
    expect(await screen.findByText("syncLogsEmpty")).toBeInTheDocument();
  });

  it("shows the empty state when the logs request fails", async () => {
    route({ [LOGS]: () => Promise.reject(new Error("network")) });
    await openLogs();
    expect(await screen.findByText("syncLogsEmpty")).toBeInTheDocument();
  });

  it("marks dry runs and shows a run's error message", async () => {
    route({
      [LOGS]: () =>
        jsonRes({ items: [log("a", { dryRun: true, status: "ERROR", errorMessage: "boom" })] }),
    });
    await openLogs();
    expect(await screen.findByText("logDryRun")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText("statusError")).toBeInTheDocument();
  });

  it("appends the next page using the returned cursor", async () => {
    route({
      [LOGS]: () => jsonRes({ items: [log("a")], nextCursor: "cur-1", hasMore: true }),
      [`${LOGS}?cursor=cur-1`]: () => jsonRes({ items: [log("b")], hasMore: false }),
    });
    await openLogs();
    await screen.findByText("start-a");
    fireEvent.click(screen.getByRole("button", { name: "loadMore" }));

    expect(await screen.findByText("start-b")).toBeInTheDocument();
    expect(screen.getByText("start-a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "loadMore" })).not.toBeInTheDocument();
  });

  it("keeps the loaded page and the load-more button when the next page fails", async () => {
    route({
      [LOGS]: () => jsonRes({ items: [log("a")], nextCursor: "cur-1", hasMore: true }),
      [`${LOGS}?cursor=cur-1`]: () => jsonRes({}, 500),
    });
    await openLogs();
    await screen.findByText("start-a");
    fireEvent.click(screen.getByRole("button", { name: "loadMore" }));
    await waitFor(() => expect(callsTo(`${LOGS}?cursor=cur-1`)).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "loadMore" })).toBeEnabled();
    expect(screen.getByText("start-a")).toBeInTheDocument();
  });
});

describe("DirectorySyncCard list fallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the empty state when the config list request fails", async () => {
    mockFetch.mockRejectedValue(new Error("network"));
    render(<DirectorySyncCard />);
    expect(await screen.findByText("noConfigs")).toBeInTheDocument();
  });

  it("shows unknown provider and status values verbatim", async () => {
    route({}, [{ ...SAMPLE_CONFIG, provider: "ONELOGIN", status: "PAUSED" }]);
    render(<DirectorySyncCard />);
    expect(await screen.findByText("ONELOGIN")).toBeInTheDocument();
    expect(screen.getByText("PAUSED")).toBeInTheDocument();
  });
});
