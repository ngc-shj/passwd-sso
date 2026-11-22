// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { vault, mockToast } = vi.hoisted(() => ({
  vault: { encryptionKey: null as CryptoKey | null },
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: mockToast }));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ encryptionKey: vault.encryptionKey, getKeyVersion: () => 1 }),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn(),
}));

// Crypto is real (Web Crypto in Node): the upload and download paths are each
// other's inverse, so a round trip through both is what proves the wire format
// and the AAD binding agree.
import { AttachmentSection, type AttachmentMeta } from "./attachment-section";
import { fetchApi } from "@/lib/url-helpers";
import { encryptBinary } from "@/lib/crypto/crypto-client";
import { buildAttachmentAAD } from "@/lib/crypto/crypto-aad";

const META: AttachmentMeta = {
  id: "a1",
  filename: "doc.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
  createdAt: "2026-01-01T00:00:00Z",
};

function okJson(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not rendered");
  return input;
}

function chooseFile(container: HTMLElement, file: File) {
  fireEvent.change(fileInput(container), { target: { files: [file] } });
}

/** Captures what the download path hands the browser. */
function captureDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return "blob:test";
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return { blobs, names };
}

/** Upload `file` for `entryId` and return the multipart body the client sent. */
async function uploadAndCapture(entryId: string, file: File): Promise<FormData> {
  const onAttachmentsChange = vi.fn();
  vi.mocked(fetchApi).mockResolvedValueOnce(okJson(META));
  const { container, unmount } = render(
    <AttachmentSection
      entryId={entryId}
      attachments={[]}
      onAttachmentsChange={onAttachmentsChange}
    />,
  );
  chooseFile(container, file);
  await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalled());
  unmount();
  const init = vi.mocked(fetchApi).mock.calls[0][1];
  if (!(init?.body instanceof FormData)) throw new Error("upload body is not FormData");
  return init.body;
}

/** Turn an uploaded multipart body into the JSON the download route returns. */
async function downloadResponseFor(form: FormData): Promise<Record<string, unknown>> {
  const file = form.get("file");
  if (!(file instanceof Blob)) throw new Error("no file part");
  return {
    encryptionMode: Number(form.get("encryptionMode")),
    encryptedData: toBase64(new Uint8Array(await file.arrayBuffer())),
    iv: form.get("iv"),
    authTag: form.get("authTag"),
    aadVersion: Number(form.get("aadVersion")),
    cekEncrypted: form.get("cekEncrypted"),
    cekIv: form.get("cekIv"),
    cekAuthTag: form.get("cekAuthTag"),
    cekKeyVersion: Number(form.get("cekKeyVersion")),
    cekWrapAadVersion: Number(form.get("cekWrapAadVersion")),
  };
}

describe("AttachmentSection", () => {
  let vaultKey: CryptoKey;

  beforeAll(async () => {
    vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vault.encryptionKey = vaultKey;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    render(
      <AttachmentSection
        entryId="e1"
        attachments={[META]}
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

  it("formats byte and megabyte sizes", () => {
    render(
      <AttachmentSection
        entryId="e1"
        attachments={[
          { ...META, id: "b", sizeBytes: 512 },
          { ...META, id: "m", sizeBytes: 3 * 1024 * 1024 },
        ]}
        onAttachmentsChange={vi.fn()}
      />,
    );

    expect(screen.getByText("512 B")).toBeInTheDocument();
    expect(screen.getByText("3.0 MB")).toBeInTheDocument();
  });

  it("marks a legacy vault-key attachment with a hint", () => {
    render(
      <AttachmentSection
        entryId="e1"
        attachments={[{ ...META, encryptionMode: 0 }]}
        onAttachmentsChange={vi.fn()}
      />,
    );

    expect(screen.getByText("legacyAttachmentHint")).toBeInTheDocument();
  });

  it("offers download but neither upload nor delete when readOnly", () => {
    render(
      <AttachmentSection
        entryId="e1"
        attachments={[META]}
        onAttachmentsChange={vi.fn()}
        readOnly={true}
      />,
    );

    expect(screen.getByTitle("download")).toBeInTheDocument();
    expect(screen.queryByTitle("delete")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upload/i })).not.toBeInTheDocument();
  });

  it("opens the file picker when Upload is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AttachmentSection entryId="e1" attachments={[]} onAttachmentsChange={vi.fn()} />,
    );
    const pick = vi.spyOn(fileInput(container), "click");

    await user.click(screen.getByRole("button", { name: /upload/i }));

    expect(pick).toHaveBeenCalled();
  });

  describe("upload", () => {
    it("uploads a CEK-wrapped encrypted file and prepends the new attachment", async () => {
      const onAttachmentsChange = vi.fn();
      const created: AttachmentMeta = { ...META, id: "new", filename: "note.txt" };
      vi.mocked(fetchApi).mockResolvedValueOnce(okJson(created));
      const { container } = render(
        <AttachmentSection
          entryId="e1"
          attachments={[META]}
          onAttachmentsChange={onAttachmentsChange}
          keyVersion={3}
        />,
      );

      chooseFile(container, new File(["hello"], "note.txt", { type: "text/plain" }));

      await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledWith([created, META]));
      expect(mockToast.success).toHaveBeenCalledWith("uploaded");
      const [url, init] = vi.mocked(fetchApi).mock.calls[0];
      expect(url).toBe("/api/passwords/e1/attachments");
      expect(init?.method).toBe("POST");
      const form = init?.body as FormData;
      expect(form.get("filename")).toBe("note.txt");
      expect(form.get("contentType")).toBe("text/plain");
      expect(form.get("sizeBytes")).toBe("5");
      expect(form.get("encryptionMode")).toBe("2");
      expect(form.get("cekKeyVersion")).toBe("3");
      expect(form.get("keyVersion")).toBe("3");
      const body = form.get("file");
      expect(body).toBeInstanceOf(Blob);
      // AES-GCM ciphertext (tag split off) is as long as the plaintext, never equal to it.
      // Compared as bytes: random ciphertext decoded as UTF-8 can merge bytes into
      // one character and change the string length.
      const sent = new Uint8Array(await (body as Blob).arrayBuffer());
      expect(sent).toHaveLength(5);
      expect(Array.from(sent)).not.toEqual(Array.from(new TextEncoder().encode("hello")));
    });

    it("reports an upload whose response body cannot be read as uploaded and reloads the list", async () => {
      const onAttachmentsChange = vi.fn();
      const reloaded: AttachmentMeta = { ...META, id: "new", filename: "note.txt" };
      vi.mocked(fetchApi)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
        } as unknown as Response)
        .mockResolvedValueOnce(okJson([reloaded, META]));
      const { container } = render(
        <AttachmentSection entryId="e1" attachments={[META]} onAttachmentsChange={onAttachmentsChange} />,
      );

      chooseFile(container, new File(["hello"], "note.txt", { type: "text/plain" }));

      await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledWith([reloaded, META]));
      expect(mockToast.success).toHaveBeenCalledWith("uploaded");
      expect(mockToast.error).not.toHaveBeenCalled();
      expect(vi.mocked(fetchApi).mock.calls[1]).toEqual(["/api/passwords/e1/attachments"]);
    });

    it("uses the vault key version and omits keyVersion when none is passed", async () => {
      const form = await uploadAndCapture(
        "e1",
        new File(["x"], "a.txt", { type: "text/plain" }),
      );

      expect(form.get("cekKeyVersion")).toBe("1");
      expect(form.has("keyVersion")).toBe(false);
    });

    it.each([
      ["a disallowed extension", new File(["x"], "run.exe", { type: "text/plain" }), "invalidExtension"],
      ["a disallowed content type", new File(["x"], "a.txt", { type: "application/zip" }), "invalidContentType"],
    ])("rejects %s without uploading", (_label, file, message) => {
      const { container } = render(
        <AttachmentSection entryId="e1" attachments={[]} onAttachmentsChange={vi.fn()} />,
      );

      chooseFile(container, file);

      expect(mockToast.error).toHaveBeenCalledWith(message);
      expect(fetchApi).not.toHaveBeenCalled();
    });

    it("rejects a file larger than the size cap without uploading", () => {
      const { container } = render(
        <AttachmentSection entryId="e1" attachments={[]} onAttachmentsChange={vi.fn()} />,
      );
      const big = new File(["x"], "big.pdf", { type: "application/pdf" });
      Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });

      chooseFile(container, big);

      expect(mockToast.error).toHaveBeenCalledWith("fileTooLarge");
      expect(fetchApi).not.toHaveBeenCalled();
    });

    it("rejects an upload once the entry holds the maximum number of files", () => {
      const full = Array.from({ length: 20 }, (_, i) => ({ ...META, id: `a${i}` }));
      const { container } = render(
        <AttachmentSection entryId="e1" attachments={full} onAttachmentsChange={vi.fn()} />,
      );

      chooseFile(container, new File(["x"], "a.txt", { type: "text/plain" }));

      expect(mockToast.error).toHaveBeenCalledWith("tooManyFiles");
      expect(fetchApi).not.toHaveBeenCalled();
    });

    it("does nothing while the vault is locked", () => {
      vault.encryptionKey = null;
      const { container } = render(
        <AttachmentSection entryId="e1" attachments={[]} onAttachmentsChange={vi.fn()} />,
      );

      chooseFile(container, new File(["x"], "a.txt", { type: "text/plain" }));

      expect(fetchApi).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it("surfaces the API error and keeps the list when the server rejects the upload", async () => {
      const onAttachmentsChange = vi.fn();
      vi.mocked(fetchApi).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
      );
      const { container } = render(
        <AttachmentSection entryId="e1" attachments={[]} onAttachmentsChange={onAttachmentsChange} />,
      );

      chooseFile(container, new File(["x"], "a.txt", { type: "text/plain" }));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
      expect(mockToast.error).not.toHaveBeenCalledWith("uploadError");
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /upload/i })).toBeEnabled();
    });

    it("reports uploadError when the request throws", async () => {
      vi.mocked(fetchApi).mockRejectedValueOnce(new TypeError("network"));
      const { container } = render(
        <AttachmentSection entryId="e1" attachments={[]} onAttachmentsChange={vi.fn()} />,
      );

      chooseFile(container, new File(["x"], "a.txt", { type: "text/plain" }));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("uploadError"));
    });
  });

  describe("download", () => {
    it("decrypts an uploaded file back to its original bytes", async () => {
      const user = userEvent.setup();
      const form = await uploadAndCapture(
        "e1",
        new File(["round-trip body"], "note.txt", { type: "text/plain" }),
      );
      const id = String(form.get("id"));
      const meta: AttachmentMeta = { ...META, id, filename: "note.txt", contentType: "text/plain" };
      const downloads = captureDownloads();
      vi.mocked(fetchApi).mockResolvedValueOnce(okJson(await downloadResponseFor(form)));
      render(<AttachmentSection entryId="e1" attachments={[meta]} onAttachmentsChange={vi.fn()} />);

      await user.click(screen.getByTitle("download"));

      await waitFor(() => expect(downloads.blobs).toHaveLength(1));
      expect(vi.mocked(fetchApi).mock.calls[1][0]).toBe(`/api/passwords/e1/attachments/${id}`);
      expect(await downloads.blobs[0].text()).toBe("round-trip body");
      expect(downloads.blobs[0].type).toBe("text/plain");
      expect(downloads.names).toEqual(["note.txt"]);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it("refuses to decrypt an attachment served under another entry", async () => {
      const user = userEvent.setup();
      const form = await uploadAndCapture(
        "e1",
        new File(["secret"], "note.txt", { type: "text/plain" }),
      );
      const meta: AttachmentMeta = { ...META, id: String(form.get("id")) };
      const downloads = captureDownloads();
      vi.mocked(fetchApi).mockResolvedValueOnce(okJson(await downloadResponseFor(form)));
      render(<AttachmentSection entryId="e2" attachments={[meta]} onAttachmentsChange={vi.fn()} />);

      await user.click(screen.getByTitle("download"));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("downloadError"));
      expect(downloads.blobs).toHaveLength(0);
    });

    it("decrypts a legacy attachment encrypted directly under the vault key", async () => {
      const user = userEvent.setup();
      const sealed = await encryptBinary(
        new TextEncoder().encode("legacy body").buffer,
        vaultKey,
        buildAttachmentAAD("e1", META.id),
      );
      const downloads = captureDownloads();
      vi.mocked(fetchApi).mockResolvedValueOnce(
        okJson({
          encryptionMode: 0,
          encryptedData: toBase64(sealed.ciphertext),
          iv: sealed.iv,
          authTag: sealed.authTag,
          aadVersion: 1,
          cekEncrypted: null,
          cekIv: null,
          cekAuthTag: null,
          cekKeyVersion: null,
          cekWrapAadVersion: null,
        }),
      );
      render(<AttachmentSection entryId="e1" attachments={[META]} onAttachmentsChange={vi.fn()} />);

      await user.click(screen.getByTitle("download"));

      await waitFor(() => expect(downloads.blobs).toHaveLength(1));
      expect(await downloads.blobs[0].text()).toBe("legacy body");
    });

    it("decrypts an aadVersion-0 attachment sealed without AAD", async () => {
      const user = userEvent.setup();
      const sealed = await encryptBinary(new TextEncoder().encode("v0").buffer, vaultKey);
      const downloads = captureDownloads();
      vi.mocked(fetchApi).mockResolvedValueOnce(
        okJson({
          encryptionMode: 0,
          encryptedData: toBase64(sealed.ciphertext),
          iv: sealed.iv,
          authTag: sealed.authTag,
          aadVersion: 0,
        }),
      );
      render(<AttachmentSection entryId="e1" attachments={[META]} onAttachmentsChange={vi.fn()} />);

      await user.click(screen.getByTitle("download"));

      await waitFor(() => expect(downloads.blobs).toHaveLength(1));
      expect(await downloads.blobs[0].text()).toBe("v0");
    });

    it("refuses a CEK wrap AAD version below the accepted minimum", async () => {
      const user = userEvent.setup();
      const form = await uploadAndCapture(
        "e1",
        new File(["x"], "note.txt", { type: "text/plain" }),
      );
      const downloads = captureDownloads();
      vi.mocked(fetchApi).mockResolvedValueOnce(
        okJson({ ...(await downloadResponseFor(form)), cekWrapAadVersion: 0 }),
      );
      render(
        <AttachmentSection
          entryId="e1"
          attachments={[{ ...META, id: String(form.get("id")) }]}
          onAttachmentsChange={vi.fn()}
        />,
      );

      await user.click(screen.getByTitle("download"));

      await waitFor(() =>
        expect(mockToast.error).toHaveBeenCalledWith("outdatedAttachmentFormat"),
      );
      expect(downloads.blobs).toHaveLength(0);
      expect(screen.getByTitle("download")).toBeEnabled();
    });

    it("reports downloadError when the server responds with an error", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchApi).mockResolvedValueOnce({ ok: false } as Response);
      render(<AttachmentSection entryId="e1" attachments={[META]} onAttachmentsChange={vi.fn()} />);

      await user.click(screen.getByTitle("download"));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("downloadError"));
    });

    it("does not fetch while the vault is locked", async () => {
      const user = userEvent.setup();
      vault.encryptionKey = null;
      render(<AttachmentSection entryId="e1" attachments={[META]} onAttachmentsChange={vi.fn()} />);

      await user.click(screen.getByTitle("download"));

      expect(fetchApi).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    const OTHER: AttachmentMeta = { ...META, id: "a2", filename: "other.pdf" };

    it("deletes the confirmed attachment and removes it from the list", async () => {
      const user = userEvent.setup();
      const onAttachmentsChange = vi.fn();
      vi.mocked(fetchApi).mockResolvedValueOnce({ ok: true } as Response);
      render(
        <AttachmentSection
          entryId="e1"
          attachments={[META, OTHER]}
          onAttachmentsChange={onAttachmentsChange}
        />,
      );

      await user.click(screen.getAllByTitle("delete")[0]);
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("confirmDeleteTitle");
      await user.click(screen.getByRole("button", { name: "delete" }));

      await waitFor(() => expect(onAttachmentsChange).toHaveBeenCalledWith([OTHER]));
      expect(fetchApi).toHaveBeenCalledWith("/api/passwords/e1/attachments/a1", {
        method: "DELETE",
      });
      expect(mockToast.success).toHaveBeenCalledWith("deleted");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("keeps the list and reports deleteError when the delete fails", async () => {
      const user = userEvent.setup();
      const onAttachmentsChange = vi.fn();
      vi.mocked(fetchApi).mockResolvedValueOnce({ ok: false } as Response);
      render(
        <AttachmentSection
          entryId="e1"
          attachments={[META]}
          onAttachmentsChange={onAttachmentsChange}
        />,
      );

      await user.click(screen.getByTitle("delete"));
      await user.click(await screen.findByRole("button", { name: "delete" }));

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("deleteError"));
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("closes the confirmation without deleting when cancelled", async () => {
      const user = userEvent.setup();
      render(<AttachmentSection entryId="e1" attachments={[META]} onAttachmentsChange={vi.fn()} />);

      await user.click(screen.getByTitle("delete"));
      await user.click(await screen.findByRole("button", { name: "cancel" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(fetchApi).not.toHaveBeenCalled();
    });
  });
});
