// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { mockParseCsv, mockParseJson, mockParseKeePassXcXml, mockIsEncryptedExport, mockDecryptExport } = vi.hoisted(() => ({
  mockParseCsv: vi.fn(),
  mockParseJson: vi.fn(),
  mockParseKeePassXcXml: vi.fn(),
  mockIsEncryptedExport: vi.fn(),
  mockDecryptExport: vi.fn(),
}));

vi.mock("@/components/passwords/password-import-utils", () => ({
  parseCsv: mockParseCsv,
  parseJson: mockParseJson,
  parseKeePassXcXml: mockParseKeePassXcXml,
}));

vi.mock("@/lib/export-crypto", () => ({
  isEncryptedExport: mockIsEncryptedExport,
  decryptExport: mockDecryptExport,
}));

import { useImportFileFlow } from "@/components/passwords/use-import-file-flow";

class MockFileReader {
  onload: ((e: { target: { result: string } }) => void) | null = null;
  readAsText(file: File) {
    const text = (file as unknown as { __text?: string }).__text ?? "";
    this.onload?.({ target: { result: text } });
  }
}

function makeFile(name: string, text: string): File {
  const file = new File([text], name, { type: "text/plain" });
  (file as unknown as { __text: string }).__text = text;
  return file;
}

describe("useImportFileFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("FileReader", MockFileReader as unknown as typeof FileReader);

    mockParseCsv.mockReturnValue({ entries: [{ id: "csv-entry" }], format: "bitwarden" });
    mockParseJson.mockReturnValue({ entries: [{ id: "json-entry" }], format: "passwd-sso" });
    mockParseKeePassXcXml.mockReturnValue({ entries: [{ id: "xml-entry" }], format: "keepassxc" });
    mockIsEncryptedExport.mockReturnValue(false);
  });

  it("loads CSV file and updates entries/format/sourceFilename", async () => {
    const { result } = renderHook(() => useImportFileFlow());
    const file = makeFile("test.csv", "csv-data");

    await act(async () => {
      result.current.handleFileChange({
        target: { files: [file] },
      } as unknown as Parameters<typeof result.current.handleFileChange>[0]);
    });

    expect(mockParseCsv).toHaveBeenCalledWith("csv-data");
    expect(result.current.entries).toEqual([{ id: "csv-entry" }]);
    expect(result.current.format).toBe("bitwarden");
    expect(result.current.sourceFilename).toBe("test.csv");
  });

  it("loads XML file and routes to parseKeePassXcXml", async () => {
    const { result } = renderHook(() => useImportFileFlow());
    const file = makeFile("export.xml", "<KeePassFile />");

    await act(async () => {
      result.current.handleFileChange({
        target: { files: [file] },
      } as unknown as Parameters<typeof result.current.handleFileChange>[0]);
    });

    expect(mockParseKeePassXcXml).toHaveBeenCalledWith("<KeePassFile />");
    expect(result.current.entries).toEqual([{ id: "xml-entry" }]);
    expect(result.current.format).toBe("keepassxc");
    expect(result.current.sourceFilename).toBe("export.xml");
  });

  it("detects encrypted JSON and enters decrypt step", async () => {
    mockIsEncryptedExport.mockReturnValue(true);
    const { result } = renderHook(() => useImportFileFlow());
    const file = makeFile("vault.json", "{\"encrypted\":true}");

    await act(async () => {
      result.current.handleFileChange({
        target: { files: [file] },
      } as unknown as Parameters<typeof result.current.handleFileChange>[0]);
    });

    expect(result.current.encryptedFile).toEqual({ encrypted: true });
    expect(result.current.encryptedInput).toBe(true);
    expect(result.current.entries).toEqual([]);
  });

  it("decrypts encrypted file and populates parsed entries", async () => {
    mockIsEncryptedExport.mockReturnValue(true);
    mockDecryptExport.mockResolvedValue({
      plaintext: "{\"entries\":[]}",
      format: "json",
    });

    const { result } = renderHook(() => useImportFileFlow());
    const file = makeFile("vault.json", "{\"encrypted\":true}");

    await act(async () => {
      result.current.handleFileChange({
        target: { files: [file] },
      } as unknown as Parameters<typeof result.current.handleFileChange>[0]);
    });

    await act(async () => {
      result.current.setDecryptPasswordAndClearError("pass");
      await result.current.handleDecrypt("decrypt failed");
    });

    expect(mockDecryptExport).toHaveBeenCalledTimes(1);
    expect(mockParseJson).toHaveBeenCalledWith("{\"entries\":[]}");
    expect(result.current.entries).toEqual([{ id: "json-entry" }]);
    expect(result.current.encryptedFile).toBeNull();
    expect(result.current.decryptPassword).toBe("");
  });
});
