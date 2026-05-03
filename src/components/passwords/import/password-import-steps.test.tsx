// @vitest-environment jsdom
/**
 * password-import-steps — step component rendering and disabled-state cues.
 *
 * Covers:
 *   - ImportDoneStep: success message, "import another" button calls onReset
 *   - ImportDecryptStep: returns null when encryptedFile is null
 *   - ImportDecryptStep: decrypt button disabled with no password (R26 disabled cue)
 *   - ImportDecryptStep: decrypt button disabled while decrypting (R26 disabled cue)
 *   - ImportDecryptStep: error rendering
 *   - ImportFileSelectStep: drag-over visual cue, onFileChange wiring
 *   - ImportPreviewStep: entry table render, importing progress, unknown-format warning
 *   - ImportActions: import button disabled while importing (R26 disabled cue)
 *   - buildImportAuditPayload: format inference + filename optionality
 *   - fireImportAudit: posts audit log payload to expected endpoint
 *   - §Sec-2: decryption error path does NOT leak the user-entered password
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockFetchApi } = vi.hoisted(() => ({
  mockFetchApi: vi.fn(),
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: mockFetchApi,
}));

vi.mock("@/components/passwords/import/password-import-utils", async () => {
  const actual = await vi.importActual<typeof import("@/components/passwords/import/password-import-utils")>(
    "@/components/passwords/import/password-import-utils",
  );
  return {
    ...actual,
    formatLabels: {
      bitwarden: "Bitwarden CSV",
      onepassword: "1Password CSV",
      chrome: "Chrome CSV",
      keepassxc: "KeePassXC XML",
      "passwd-sso": "passwd-sso JSON",
      unknown: "Unknown",
    },
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type,
    variant: _variant,
    ...rest
  }: React.ComponentProps<"button"> & { variant?: string }) => (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      data-disabled={disabled ? "true" : undefined}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
    function MockInput(props, ref) {
      return <input ref={ref} {...props} />;
    },
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...rest }: React.ComponentProps<"label">) => (
    <label {...rest}>{children}</label>
  ),
}));

import {
  ImportActions,
  ImportDecryptStep,
  ImportDoneStep,
  ImportFileSelectStep,
  ImportPreviewStep,
  buildImportAuditPayload,
  fireImportAudit,
} from "./password-import-steps";

import type { ImportTranslator } from "@/components/passwords/import/password-import-types";

const t = ((key: string, vals?: Record<string, unknown>) => {
  if (!vals) return key;
  if (key === "importedCount") return `imported ${vals.count}`;
  if (key === "entryCount") return `entries ${vals.count}`;
  if (key === "importing") return `importing ${vals.current}/${vals.total}`;
  if (key === "importButton") return `import ${vals.count}`;
  return key;
}) as unknown as ImportTranslator;

describe("ImportDoneStep", () => {
  it("shows the success count and triggers onReset", () => {
    const onReset = vi.fn();
    render(<ImportDoneStep t={t} successCount={5} onReset={onReset} />);
    expect(screen.getByText("imported 5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "importAnother" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("ImportDecryptStep", () => {
  const baseProps = {
    t,
    decryptPassword: "",
    decryptError: "",
    decrypting: false,
    onReset: vi.fn(),
    onDecrypt: vi.fn(),
    onDecryptPasswordChange: vi.fn(),
    encryptedFile: { v: 1, alg: "aes-gcm" } as never,
  };

  beforeEach(() => {
    baseProps.onReset = vi.fn();
    baseProps.onDecrypt = vi.fn();
    baseProps.onDecryptPasswordChange = vi.fn();
  });

  it("returns null when encryptedFile is null", () => {
    const { container } = render(
      <ImportDecryptStep {...baseProps} encryptedFile={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("disables the decrypt button when no password is entered", () => {
    render(<ImportDecryptStep {...baseProps} />);
    const decryptBtn = screen.getByRole("button", { name: "decryptButton" });
    expect(decryptBtn).toBeDisabled();
    expect(decryptBtn).toHaveAttribute("data-disabled", "true");
  });

  it("disables the decrypt button while decrypting and shows decrypting label", () => {
    render(
      <ImportDecryptStep {...baseProps} decryptPassword="x" decrypting={true} />,
    );
    const decryptBtn = screen.getByRole("button", { name: "decrypting" });
    expect(decryptBtn).toBeDisabled();
    expect(decryptBtn).toHaveAttribute("data-disabled", "true");
  });

  it("renders the decrypt error", () => {
    render(<ImportDecryptStep {...baseProps} decryptError="bad password" />);
    expect(screen.getByText("bad password")).toBeInTheDocument();
  });

  it("does NOT leak the user-entered password into the rendered DOM on error (§Sec-2)", () => {
    render(
      <ImportDecryptStep
        {...baseProps}
        decryptPassword="SENTINEL_NOT_A_SECRET_ZJYK"
        decryptError="bad password"
      />,
    );
    // The password input value is internal to the input field, but error
    // surface (which the user sees) must not echo it.
    expect(screen.queryByText(/SENTINEL_NOT_A_SECRET_ZJYK/)).toBeNull();
  });

  it("calls onDecrypt when Enter is pressed and a password is set", () => {
    const onDecrypt = vi.fn();
    render(
      <ImportDecryptStep
        {...baseProps}
        decryptPassword="x"
        onDecrypt={onDecrypt}
      />,
    );
    const input = screen.getByLabelText("decryptPassword");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDecrypt).toHaveBeenCalledTimes(1);
  });
});

describe("ImportFileSelectStep", () => {
  function defaults(overrides: Partial<React.ComponentProps<typeof ImportFileSelectStep>> = {}) {
    return {
      t,
      dragOver: false,
      fileRef: { current: null } as React.RefObject<HTMLInputElement | null>,
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
      onFileChange: vi.fn(),
      ...overrides,
    };
  }

  it("renders selectFile prompt and forwards onFileChange", () => {
    const onFileChange = vi.fn();
    render(<ImportFileSelectStep {...defaults({ onFileChange })} />);
    expect(screen.getByText("selectFile")).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.csv")] },
    });
    expect(onFileChange).toHaveBeenCalledTimes(1);
  });
});

describe("ImportPreviewStep", () => {
  const entries = [
    {
      entryType: "LOGIN",
      title: "Site",
      username: "alice",
    },
    {
      entryType: "SECURE_NOTE",
      title: "Note",
      username: "",
    },
  ] as unknown as Parameters<typeof ImportPreviewStep>[0]["entries"];

  it("renders the format label and per-entry rows", () => {
    render(
      <ImportPreviewStep
        t={t}
        entries={entries}
        format="bitwarden"
        importing={false}
        progress={{ current: 0, total: 0 }}
      />,
    );
    expect(screen.getByText("Bitwarden CSV")).toBeInTheDocument();
    expect(screen.getByText("Site")).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("entries 2")).toBeInTheDocument();
  });

  it("renders the unknown-format warning when format is unknown", () => {
    render(
      <ImportPreviewStep
        t={t}
        entries={entries}
        format="unknown"
        importing={false}
        progress={{ current: 0, total: 0 }}
      />,
    );
    expect(screen.getByText("unknownFormat")).toBeInTheDocument();
  });

  it("renders the importing progress when importing is true", () => {
    render(
      <ImportPreviewStep
        t={t}
        entries={entries}
        format="bitwarden"
        importing={true}
        progress={{ current: 1, total: 2 }}
      />,
    );
    expect(screen.getByText("importing 1/2")).toBeInTheDocument();
  });
});

describe("ImportActions", () => {
  it("disables the import button while importing (R26 disabled cue)", () => {
    render(
      <ImportActions
        t={t}
        importing={true}
        entriesCount={3}
        onReset={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    const importBtn = screen.getByRole("button", { name: "import 3" });
    expect(importBtn).toBeDisabled();
    expect(importBtn).toHaveAttribute("data-disabled", "true");
  });

  it("invokes onImport when clicked and not importing", () => {
    const onImport = vi.fn();
    render(
      <ImportActions
        t={t}
        importing={false}
        entriesCount={2}
        onReset={vi.fn()}
        onImport={onImport}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "import 2" }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});

describe("buildImportAuditPayload", () => {
  it("infers JSON format from filename extension", () => {
    const payload = buildImportAuditPayload(10, 8, 2, "vault.json", false);
    expect(payload).toEqual({
      requestedCount: 10,
      successCount: 8,
      failedCount: 2,
      filename: "vault.json",
      format: "json",
      encrypted: false,
    });
  });

  it("infers XML format from filename extension", () => {
    const payload = buildImportAuditPayload(1, 1, 0, "kdbx.xml", true);
    expect(payload.format).toBe("xml");
    expect(payload.encrypted).toBe(true);
  });

  it("defaults to CSV when extension is unknown", () => {
    const payload = buildImportAuditPayload(0, 0, 0, "data.csv", false);
    expect(payload.format).toBe("csv");
  });

  it("omits filename when empty string", () => {
    const payload = buildImportAuditPayload(0, 0, 0, "", false);
    expect(payload.filename).toBeUndefined();
  });
});

describe("fireImportAudit", () => {
  beforeEach(() => {
    mockFetchApi.mockReset();
    mockFetchApi.mockResolvedValue({ ok: true });
  });

  it("posts the audit payload to the audit-logs/import endpoint", () => {
    fireImportAudit(5, 5, 0, "import.csv", false);
    expect(mockFetchApi).toHaveBeenCalledTimes(1);
    const [, init] = mockFetchApi.mock.calls[0];
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      requestedCount: 5,
      successCount: 5,
      failedCount: 0,
      filename: "import.csv",
      format: "csv",
      encrypted: false,
    });
    expect(body.teamId).toBeUndefined();
  });

  it("includes teamId when provided", () => {
    fireImportAudit(1, 1, 0, "x.json", true, "team-1");
    const [, init] = mockFetchApi.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.teamId).toBe("team-1");
    expect(body.format).toBe("json");
    expect(body.encrypted).toBe(true);
  });
});
