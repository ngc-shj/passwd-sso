// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { API_PATH } from "@/lib/constants";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";

const { mockFetchApi, mockHardNavigate } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockHardNavigate: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "ja",
}));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
  hardNavigate: mockHardNavigate,
}));

import AdminVaultResetPage from "./page";

const TOKEN = "ab".repeat(32);
const PHRASE = VAULT_CONFIRMATION_PHRASE.DELETE_VAULT;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
}

function confirmAndSubmit() {
  fireEvent.change(screen.getByLabelText("confirmationLabel"), { target: { value: PHRASE } });
  fireEvent.click(screen.getByRole("button", { name: "resetButton" }));
}

describe("AdminVaultResetPage", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockHardNavigate.mockReset();
  });

  it("shows the no-token notice when the URL carries no token", () => {
    setUrl("/ja/vault-reset/admin");
    render(<AdminVaultResetPage />);

    expect(screen.getByText("adminResetNoToken")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "resetButton" })).toBeNull();
  });

  it("shows the no-token notice for a token that is not 64 hex chars", () => {
    setUrl("/ja/vault-reset/admin#token=zz");
    render(<AdminVaultResetPage />);

    expect(screen.getByText("adminResetNoToken")).toBeInTheDocument();
  });

  it("shows the reset form for a valid token and strips it from the URL", () => {
    setUrl(`/ja/vault-reset/admin#token=${TOKEN}`);
    render(<AdminVaultResetPage />);

    expect(screen.getByText("adminResetTitle")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/ja/vault-reset/admin");
  });

  it("keeps the submit button disabled until the confirmation phrase matches", () => {
    setUrl(`/ja/vault-reset/admin#token=${TOKEN}`);
    render(<AdminVaultResetPage />);
    const submit = screen.getByRole("button", { name: "resetButton" });

    fireEvent.change(screen.getByLabelText("confirmationLabel"), { target: { value: "nope" } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("confirmationLabel"), { target: { value: PHRASE } });
    expect(submit).toBeEnabled();
  });

  it("posts the token and phrase, then hard-navigates to the dashboard", async () => {
    setUrl(`/ja/vault-reset/admin#token=${TOKEN}`);
    mockFetchApi.mockImplementation(async () => json({ ok: true }));
    render(<AdminVaultResetPage />);

    confirmAndSubmit();

    await waitFor(() => expect(mockHardNavigate).toHaveBeenCalledWith("/ja/dashboard"));
    const [path, init] = mockFetchApi.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(API_PATH.VAULT_ADMIN_RESET);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN, confirmation: PHRASE });
  });

  it("maps an API error code to its translated message", async () => {
    setUrl(`/ja/vault-reset/admin#token=${TOKEN}`);
    mockFetchApi.mockImplementation(async () => json({ error: "NOT_FOUND" }, 404));
    render(<AdminVaultResetPage />);

    confirmAndSubmit();

    expect(await screen.findByText("notFound")).toBeInTheDocument();
    expect(mockHardNavigate).not.toHaveBeenCalled();
  });

  it("shows the unknown error for an error response without a code", async () => {
    setUrl(`/ja/vault-reset/admin#token=${TOKEN}`);
    mockFetchApi.mockResolvedValue(new Response("oops", { status: 500 }));
    render(<AdminVaultResetPage />);

    confirmAndSubmit();

    expect(await screen.findByText("unknownError")).toBeInTheDocument();
  });

  it("shows the unknown error when the request throws", async () => {
    setUrl(`/ja/vault-reset/admin#token=${TOKEN}`);
    mockFetchApi.mockRejectedValue(new Error("offline"));
    render(<AdminVaultResetPage />);

    confirmAndSubmit();

    expect(await screen.findByText("unknownError")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "resetButton" })).toBeEnabled();
  });

  it("shows the resetting label while the request is in flight", async () => {
    setUrl(`/ja/vault-reset/admin#token=${TOKEN}`);
    mockFetchApi.mockReturnValue(new Promise(() => {}));
    render(<AdminVaultResetPage />);

    confirmAndSubmit();

    expect(await screen.findByRole("button", { name: "resetting" })).toBeDisabled();
  });
});
