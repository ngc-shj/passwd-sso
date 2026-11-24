// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetchApi, mockUseSession } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
  mockUseSession: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("next-auth/react", () => ({ useSession: () => mockUseSession() }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (path: string) => mockFetchApi(path),
}));

vi.mock("@/components/emergency-access/grant-card", () => ({
  GrantCard: vi.fn(({ grant }: { grant: { id: string } }) => (
    <div data-testid="grant-card">{grant.id}</div>
  )),
}));

vi.mock("@/components/emergency-access/create-grant-dialog", () => ({
  CreateGrantDialog: vi.fn(() => <div data-testid="create-grant-dialog" />),
}));

vi.mock("@/components/settings/shared/inactive-items-section", () => ({
  InactiveItemsSection: ({
    triggerLabel,
    open,
    onOpenChange,
    children,
  }: {
    triggerLabel: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange(!open)}>
        {triggerLabel}
      </button>
      {open && <div data-testid="inactive-items">{children}</div>}
    </div>
  ),
}));

vi.mock("@/components/settings/account/section-card-header", () => ({
  SectionCardHeader: ({ title, action }: { title: string; action?: React.ReactNode }) => (
    <div>
      <h2>{title}</h2>
      {action}
    </div>
  ),
}));

import EmergencyAccessPage from "./page";
import { GrantCard } from "@/components/emergency-access/grant-card";
import { CreateGrantDialog } from "@/components/emergency-access/create-grant-dialog";
import { EA_STATUS } from "@/lib/constants";

const USER_ID = "user-1";

function grant(id: string, ownerId: string, status: string) {
  return {
    id,
    ownerId,
    granteeId: ownerId === USER_ID ? "other" : USER_ID,
    granteeEmail: "g@example.com",
    status,
    waitDays: 7,
    requestedAt: null,
    waitExpiresAt: null,
    createdAt: "2026-05-01",
    owner: { id: ownerId, name: null, email: null },
    grantee: null,
  };
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

async function renderPage() {
  await act(async () => {
    render(<EmergencyAccessPage />);
  });
}

function renderedGrantIds(): string[] {
  return screen.queryAllByTestId("grant-card").map((el) => el.textContent ?? "");
}

describe("EmergencyAccessPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({ data: { user: { id: USER_ID } } });
  });

  it("renders nothing without a signed-in user", async () => {
    mockUseSession.mockReturnValue({ data: null });
    mockFetchApi.mockResolvedValue(okJson([]));
    const { container } = render(<EmergencyAccessPage />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the loading placeholder in both sections until grants arrive", () => {
    mockFetchApi.mockReturnValue(new Promise(() => {}));
    render(<EmergencyAccessPage />);
    expect(screen.getAllByText("...")).toHaveLength(2);
  });

  it("fetches the grant list from the emergency-access endpoint", async () => {
    mockFetchApi.mockResolvedValue(okJson([]));
    await renderPage();
    expect(mockFetchApi).toHaveBeenCalledWith("/api/emergency-access");
  });

  it("shows both empty states when there are no grants", async () => {
    mockFetchApi.mockResolvedValue(okJson([]));
    await renderPage();
    expect(screen.getByText("noGrants")).toBeInTheDocument();
    expect(screen.getByText("noTrustedBy")).toBeInTheDocument();
    expect(renderedGrantIds()).toEqual([]);
  });

  it("shows the empty states when the list request is refused", async () => {
    mockFetchApi.mockResolvedValue({ ok: false, json: async () => [] });
    await renderPage();
    expect(screen.getByText("noGrants")).toBeInTheDocument();
    expect(screen.queryByText("...")).toBeNull();
  });

  it("splits grants into the owner's and the grantee's sections, active first", async () => {
    mockFetchApi.mockResolvedValue(
      okJson([
        grant("own-active", USER_ID, EA_STATUS.IDLE),
        grant("own-revoked", USER_ID, EA_STATUS.REVOKED),
        grant("in-active", "other", EA_STATUS.PENDING),
        grant("in-rejected", "other", EA_STATUS.REJECTED),
      ]),
    );
    await renderPage();

    // Inactive grants stay collapsed until their section is opened.
    expect(renderedGrantIds()).toEqual(["own-active", "in-active"]);
    expect(screen.getAllByText(`inactiveGrants:${JSON.stringify({ count: "1" })}`)).toHaveLength(2);
    expect(screen.queryByText("noGrants")).toBeNull();
    expect(screen.queryByText("noTrustedBy")).toBeNull();
  });

  it("passes each card the signed-in user and a refresh that refetches", async () => {
    mockFetchApi.mockResolvedValue(okJson([grant("own-active", USER_ID, EA_STATUS.IDLE)]));
    await renderPage();

    const props = vi.mocked(GrantCard).mock.calls.at(-1)?.[0];
    expect(props?.currentUserId).toBe(USER_ID);
    expect(props?.grant.id).toBe("own-active");

    await act(async () => {
      props?.onRefresh();
    });
    expect(mockFetchApi).toHaveBeenCalledTimes(2);
  });

  it("refetches the list when a grant is created", async () => {
    mockFetchApi.mockResolvedValue(okJson([]));
    await renderPage();

    mockFetchApi.mockResolvedValue(okJson([grant("new", USER_ID, EA_STATUS.PENDING)]));
    const onCreated = vi.mocked(CreateGrantDialog).mock.calls.at(-1)?.[0].onCreated;
    await act(async () => {
      onCreated?.();
    });

    expect(renderedGrantIds()).toEqual(["new"]);
  });

  it("shows the owner's empty state above a collapsed list of only inactive grants", async () => {
    mockFetchApi.mockResolvedValue(okJson([grant("own-revoked", USER_ID, EA_STATUS.REVOKED)]));
    await renderPage();

    expect(screen.getByText("noGrants")).toBeInTheDocument();
    expect(renderedGrantIds()).toEqual([]);

    fireEvent.click(screen.getByText(`inactiveGrants:${JSON.stringify({ count: "1" })}`));
    expect(renderedGrantIds()).toEqual(["own-revoked"]);
  });

  it("shows the grantee's empty state above a collapsed list of only inactive grants", async () => {
    mockFetchApi.mockResolvedValue(okJson([grant("in-rejected", "other", EA_STATUS.REJECTED)]));
    await renderPage();

    expect(screen.getByText("noTrustedBy")).toBeInTheDocument();
    expect(renderedGrantIds()).toEqual([]);

    fireEvent.click(screen.getByText(`inactiveGrants:${JSON.stringify({ count: "1" })}`));
    expect(renderedGrantIds()).toEqual(["in-rejected"]);
  });
});
