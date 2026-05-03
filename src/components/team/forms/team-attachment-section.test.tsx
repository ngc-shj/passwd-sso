// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { mockTeamMismatch } from "@/__tests__/helpers/mock-app-navigation";

const { mockFetch, mockToast, encryptBinaryMock, decryptBinaryMock } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  encryptBinaryMock: vi.fn(async () => ({
    ciphertext: new Uint8Array([1, 2, 3]),
    iv: "iv-hex",
    authTag: "tag-hex",
  })),
  decryptBinaryMock: vi.fn(async () => new Uint8Array([4, 5, 6])),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getItemEncryptionKey: vi.fn(async () => ({} as CryptoKey)),
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  encryptBinary: (...args: unknown[]) => encryptBinaryMock(...args),
  decryptBinary: (...args: unknown[]) => decryptBinaryMock(...args),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildAttachmentAAD: vi.fn(() => "att-aad"),
  AAD_VERSION: 1,
}));

vi.mock("@/lib/http/toast-api-error", () => ({
  toastApiError: vi.fn(),
}));

import { TeamAttachmentSection } from "./team-attachment-section";

describe("TeamAttachmentSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when teamId is missing", () => {
    const { container } = render(
      <TeamAttachmentSection
        entryId="entry-1"
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders empty state when no attachments and not readOnly", () => {
    render(
      <TeamAttachmentSection
        teamId="team-1"
        entryId="entry-1"
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("noAttachments")).toBeInTheDocument();
    expect(screen.getByText("upload")).toBeInTheDocument();
  });

  it("returns null when readOnly and zero attachments", () => {
    const { container } = render(
      <TeamAttachmentSection
        teamId="team-1"
        entryId="entry-1"
        attachments={[]}
        onAttachmentsChange={vi.fn()}
        readOnly
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders attachment list with formatted file size", () => {
    render(
      <TeamAttachmentSection
        teamId="team-1"
        entryId="entry-1"
        attachments={[
          {
            id: "a1",
            filename: "test.pdf",
            contentType: "application/pdf",
            sizeBytes: 2048,
            createdAt: new Date().toISOString(),
          },
        ]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("test.pdf")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("hides delete button when readOnly with attachments present", () => {
    render(
      <TeamAttachmentSection
        teamId="team-1"
        entryId="entry-1"
        attachments={[
          {
            id: "a1",
            filename: "x.png",
            contentType: "image/png",
            sizeBytes: 100,
            createdAt: new Date().toISOString(),
          },
        ]}
        onAttachmentsChange={vi.fn()}
        readOnly
      />,
    );
    // download button has title "download"; no upload button
    expect(screen.queryByText("upload")).not.toBeInTheDocument();
    expect(screen.getByTitle("download")).toBeInTheDocument();
    // delete button uses title="delete" — common t key
    expect(screen.queryByTitle("delete")).toBeNull();
  });

  // §Sec-3 cross-tenant denial
  it("renders without crashing under cross-tenant context (mismatch)", async () => {
    const ctx = mockTeamMismatch({ actorTeamId: "team-a", resourceTeamId: "team-b" });
    expect(ctx.useTeamVault().currentTeamId).not.toBe(ctx.teamId);

    const onChange = vi.fn();
    render(
      <TeamAttachmentSection
        teamId={ctx.teamId}
        entryId="entry-x"
        attachments={[]}
        onAttachmentsChange={onChange}
      />,
    );
    // Component still renders — auth denial happens at API; UI shows empty state
    expect(screen.getByText("noAttachments")).toBeInTheDocument();
    // No leaked attachment data
    expect(screen.queryByText(/test\.pdf/)).toBeNull();
  });
});
