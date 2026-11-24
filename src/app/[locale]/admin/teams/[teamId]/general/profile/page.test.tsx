// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TEAM_DATA_CHANGED_EVENT } from "@/lib/events";

const { mockFetchApi, mockToast } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/i18n/navigation", async () => {
  const { mockI18nNavigation } = await import("@/__tests__/helpers/mock-app-navigation");
  return mockI18nNavigation();
});
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/lib/url-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-helpers")>()),
  fetchApi: mockFetchApi,
}));

import TeamGeneralProfilePage from "./page";

const TEAM = { id: "t1", name: "Platform", slug: "platform", description: null, role: "OWNER" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function renderPage(teamId = "t1") {
  const params = Promise.resolve({ teamId });
  await act(async () => {
    render(
      <React.Suspense fallback={<div>suspended</div>}>
        <TeamGeneralProfilePage params={params} />
      </React.Suspense>,
    );
  });
}

describe("TeamGeneralProfilePage", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
  });

  it("fills the form from the fetched team for an owner", async () => {
    mockFetchApi.mockImplementation(async () => json(TEAM));
    await renderPage();

    expect(await screen.findByLabelText("teamName")).toHaveValue("Platform");
    expect(screen.getByLabelText("slug")).toHaveValue("platform");
    expect(screen.getByLabelText("description")).toHaveValue("");
    expect(mockFetchApi).toHaveBeenCalledWith("/api/teams/t1");
  });

  it("shows the editable form to a team admin", async () => {
    mockFetchApi.mockImplementation(async () => json({ ...TEAM, role: "ADMIN" }));
    await renderPage();

    expect(await screen.findByLabelText("teamName")).toBeInTheDocument();
  });

  it("shows only the forbidden notice to a plain member", async () => {
    mockFetchApi.mockImplementation(async () => json({ ...TEAM, role: "MEMBER" }));
    await renderPage();

    expect(await screen.findByText("generalProfileTitle")).toBeInTheDocument();
    expect(screen.getByText("forbidden")).toBeInTheDocument();
    expect(screen.queryByLabelText("teamName")).toBeNull();
  });

  it("shows the forbidden card with a link back when the fetch fails", async () => {
    mockFetchApi.mockImplementation(async () => json({ error: "FORBIDDEN" }, 403));
    await renderPage();

    expect(await screen.findByRole("link", { name: "manage" })).toHaveAttribute("href", "/dashboard/teams");
    expect(screen.getByText("forbidden")).toBeInTheDocument();
  });

  it("keeps the save button disabled until the form changes", async () => {
    mockFetchApi.mockImplementation(async () => json(TEAM));
    await renderPage();
    const save = await screen.findByRole("button", { name: "updateTeam" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("teamName"), { target: { value: "Platform 2" } });
    expect(save).toBeEnabled();
  });

  it("keeps the save button disabled for a whitespace-only name", async () => {
    mockFetchApi.mockImplementation(async () => json(TEAM));
    await renderPage();

    fireEvent.change(await screen.findByLabelText("teamName"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "updateTeam" })).toBeDisabled();
  });

  it("saves the trimmed values, refetches, and announces the change", async () => {
    mockFetchApi.mockImplementation(async () => json(TEAM));
    const listener = vi.fn();
    window.addEventListener(TEAM_DATA_CHANGED_EVENT, listener);
    await renderPage();

    fireEvent.change(await screen.findByLabelText("teamName"), { target: { value: "  New  " } });
    fireEvent.change(screen.getByLabelText("description"), { target: { value: " desc " } });
    fireEvent.click(screen.getByRole("button", { name: "updateTeam" }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("updated"));
    const put = mockFetchApi.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(put?.[0]).toBe("/api/teams/t1");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ name: "New", description: "desc" });
    expect(listener).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockFetchApi).toHaveBeenCalledTimes(3));
    window.removeEventListener(TEAM_DATA_CHANGED_EVENT, listener);
  });

  it("shows the validation error on a 400 response", async () => {
    mockFetchApi.mockResolvedValueOnce(json(TEAM)).mockResolvedValueOnce(json({ error: "VALIDATION_ERROR" }, 400));
    await renderPage();

    fireEvent.change(await screen.findByLabelText("teamName"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "updateTeam" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("validationError"));
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("shows the update-failed error on another error response", async () => {
    mockFetchApi.mockResolvedValueOnce(json(TEAM)).mockResolvedValueOnce(json({}, 500));
    await renderPage();

    fireEvent.change(await screen.findByLabelText("teamName"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "updateTeam" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("updateFailed"));
  });
});
