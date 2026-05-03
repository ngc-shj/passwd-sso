// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ encryptionKey: {} as CryptoKey }),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn(),
}));

vi.mock("@/lib/crypto/crypto-client", () => ({
  encryptBinary: vi.fn(),
  decryptBinary: vi.fn(),
}));

vi.mock("@/lib/crypto/crypto-aad", () => ({
  buildAttachmentAAD: vi.fn().mockReturnValue("aad"),
  AAD_VERSION: 1,
}));

import { AttachmentSection } from "./attachment-section";

describe("AttachmentSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when readOnly and there are no attachments", () => {
    const { container } = render(
      <AttachmentSection
        entryId="e1"
        attachments={[]}
        onAttachmentsChange={vi.fn()}
        readOnly={true}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the noAttachments message when not readOnly and no attachments", () => {
    render(
      <AttachmentSection
        entryId="e1"
        attachments={[]}
        onAttachmentsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("noAttachments")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upload/i })).toBeInTheDocument();
  });

  it("renders existing attachments with filename and size", () => {
    const attachments = [
      {
        id: "a1",
        filename: "doc.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    render(
      <AttachmentSection
        entryId="e1"
        attachments={attachments}
        onAttachmentsChange={vi.fn()}
      />,
    );

    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  // R26 — Upload button visible disabled cue when uploading or at limit
  it("disables Upload button when at MAX_ATTACHMENTS_PER_ENTRY", () => {
    // Generate enough attachments to hit the cap (constant is internal — generate 10 to be safe)
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`,
      filename: `f${i}.txt`,
      contentType: "text/plain",
      sizeBytes: 1,
      createdAt: "2026-01-01T00:00:00Z",
    }));

    render(
      <AttachmentSection
        entryId="e1"
        attachments={many}
        onAttachmentsChange={vi.fn()}
      />,
    );

    const uploadBtn = screen.getByRole("button", { name: /upload/i });
    expect(uploadBtn).toBeDisabled();
    expect(uploadBtn.className).toMatch(/disabled:opacity-/);
  });
});
