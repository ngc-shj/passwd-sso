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

import { render, screen } from "@testing-library/react";
import { mockTeamMismatch } from "@/__tests__/helpers/mock-app-navigation";
import type { encryptBinary, decryptBinary } from "@/lib/crypto/crypto-client";

const { mockFetch, mockToast, encryptBinaryMock, decryptBinaryMock, mockUpload, activeVault } = vi.hoisted(() => ({
  activeVault: { current: { type: "team", teamId: "team-1", teamRole: "OWNER" } as Record<string, unknown> | null },
  mockFetch: vi.fn(),
  mockUpload: vi.fn(),
  mockToast: { error: vi.fn(), success: vi.fn() },
  encryptBinaryMock: vi.fn<typeof encryptBinary>(async () => ({
    ciphertext: new Uint8Array([1, 2, 3]),
    iv: "iv-hex",
    authTag: "tag-hex",
  })),
  decryptBinaryMock: vi.fn<typeof decryptBinary>(
    async () => new Uint8Array([4, 5, 6]).buffer,
  ),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/vault/active-vault-context", () => ({
  useActiveVault: () => activeVault.current,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("@/lib/team/team-vault-context", () => ({
  useTeamVault: () => ({
    getItemEncryptionKey: vi.fn(),
    getTeamKeyInfo: vi.fn(async () => null),
    // No key is available to this member at any version.
    resolveTeamKey: vi.fn(async () => ({ reason: "not_available" })),
  }),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  encryptBinary: encryptBinaryMock,
  decryptBinary: decryptBinaryMock,
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildAttachmentAAD: vi.fn(() => "att-aad"),
  AAD_VERSION: 1,
  VAULT_TYPE: { BLOB: "blob", OVERVIEW: "overview" },
}));

vi.mock("@/lib/http/toast-api-error", () => ({
  toastApiError: vi.fn(),
}));

vi.mock("@/lib/team/team-attachment-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/team/team-attachment-upload")>()),
  uploadTeamAttachment: (...args: unknown[]) => mockUpload(...args),
}));

import { TeamAttachmentSection } from "./team-attachment-section";
import { fireEvent, waitFor } from "@testing-library/react";
import { toastApiError } from "@/lib/http/toast-api-error";

describe("TeamAttachmentSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeVault.current = { type: "team", teamId: "team-1", teamRole: "OWNER" };
  });

  const oneAttachment = [
    { id: "a1", filename: "x.png", contentType: "image/png", sizeBytes: 100, createdAt: new Date().toISOString() },
  ];

  // The delete route requires PASSWORD_DELETE: OWNER/ADMIN, not MEMBER.
  it.each([
    ["OWNER of this team", { type: "team", teamId: "team-1", teamRole: "OWNER" }, true],
    ["ADMIN of this team", { type: "team", teamId: "team-1", teamRole: "ADMIN" }, true],
    ["MEMBER of this team", { type: "team", teamId: "team-1", teamRole: "MEMBER" }, false],
    ["OWNER of another team", { type: "team", teamId: "team-2", teamRole: "OWNER" }, false],
    ["no active vault", null, false],
  ])("delete control for %s: %s", (_label, vault, shown) => {
    activeVault.current = vault;
    render(
      <TeamAttachmentSection teamId="team-1" entryId="entry-1" attachments={oneAttachment} onAttachmentsChange={vi.fn()} />,
    );
    expect(screen.queryByTitle("delete") !== null).toBe(shown);
    // Upload is not part of this rule.
    expect(screen.getByText("upload")).toBeInTheDocument();
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

  describe("download", () => {
    const ATT = { id: "a1", filename: "x.png", contentType: "image/png", sizeBytes: 100, createdAt: new Date().toISOString() };

    it("surfaces ATTACHMENT_KEY_UNAVAILABLE from the server with its exit", async () => {
      const res = new Response(JSON.stringify({ error: "ATTACHMENT_KEY_UNAVAILABLE" }), { status: 409 });
      mockFetch.mockResolvedValue(res);
      render(<TeamAttachmentSection teamId="team-1" entryId="entry-1" attachments={[ATT]} onAttachmentsChange={vi.fn()} />);

      fireEvent.click(screen.getByTitle("download"));

      await waitFor(() => expect(toastApiError).toHaveBeenCalledWith(res, expect.any(Function)));
    });

    it("says the attachment key is unavailable when no key this member holds opens it", async () => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({
        id: "a1", filename: "x.png", contentType: "image/png", sizeBytes: 100,
        encryptedData: "AAAA", iv: "0".repeat(24), authTag: "0".repeat(32), aadVersion: 1,
        encryptionMode: 0, keyVersion: 1,
      }), { status: 200 }));
      render(<TeamAttachmentSection teamId="team-1" entryId="entry-1" attachments={[ATT]} onAttachmentsChange={vi.fn()} />);

      fireEvent.click(screen.getByTitle("download"));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("attachmentKeyUnavailable"));
    });
  });

  describe("upload refusals", () => {
    async function uploadOne() {
      const { container } = render(
        <TeamAttachmentSection teamId="team-1" entryId="entry-1" attachments={[]} onAttachmentsChange={vi.fn()} />,
      );
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(["abc"], "doc.pdf", { type: "application/pdf" });
      fireEvent.change(input, { target: { files: [file] } });
    }

    it("ENTRY_REKEY_REQUIRED says an owner or admin must finish the re-key (as the entry save does)", async () => {
      mockUpload.mockResolvedValue(new Response(JSON.stringify({ error: "ENTRY_REKEY_REQUIRED" }), { status: 409 }));
      await uploadOne();
      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("uploadRekeyRequired"));
      expect(toastApiError).not.toHaveBeenCalled();
    });

    it("control: another refusal (ONLY_OWN_ENTRIES) shows the server's own message", async () => {
      const res = new Response(JSON.stringify({ error: "ONLY_OWN_ENTRIES" }), { status: 403 });
      mockUpload.mockResolvedValue(res);
      await uploadOne();
      await waitFor(() => expect(toastApiError).toHaveBeenCalledWith(res, expect.any(Function)));
      expect(mockToast.error).not.toHaveBeenCalledWith("uploadRekeyRequired");
    });
  });
});
