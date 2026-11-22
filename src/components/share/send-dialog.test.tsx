// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockCopySecret } = vi.hoisted(() => ({ mockCopySecret: vi.fn() }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog">
        <button type="button" onClick={() => onOpenChange(false)}>dismiss</button>
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ComponentProps<"button">) => (
    <button onClick={onClick} disabled={disabled} {...rest}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <select aria-label="expiresInLabel" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

// Tabs keep the component's controlled value wired so switching to the file tab changes the submit path.
vi.mock("@/components/ui/tabs", async () => {
  const { createContext, useContext } = await import("react");
  const TabsCtx = createContext<(v: string) => void>(() => {});
  return {
    Tabs: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange: (v: string) => void;
    }) => <TabsCtx.Provider value={onValueChange}><div>{children}</div></TabsCtx.Provider>,
    TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
    TabsTrigger: function TabsTrigger({
      children,
      value,
      ...rest
    }: { children: React.ReactNode; value: string } & React.ComponentProps<"button">) {
      const select = useContext(TabsCtx);
      return (
        <button role="tab" data-value={value} onClick={() => select(value)} {...rest}>{children}</button>
      );
    },
    TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) => (
      <div role="tabpanel" data-value={value}>{children}</div>
    ),
  };
});

vi.mock("@/components/ui/switch", () => ({
  Switch: ({ checked, onCheckedChange, ...rest }: { checked: boolean; onCheckedChange: (v: boolean) => void } & React.ComponentProps<"button">) => (
    <button role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...rest} />
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/http/api-error-codes", () => ({
  apiErrorToI18nKey: (e: string) => e,
}));

vi.mock("@/lib/clipboard/copy-secret", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clipboard/copy-secret")>();
  return { ...actual, copySecretToClipboard: mockCopySecret };
});

vi.mock("@/lib/validations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/validations")>();
  return { ...actual };
});

import { SendDialog } from "./send-dialog";
import { toast } from "sonner";
import { COPY_OUTCOME } from "@/lib/clipboard/copy-secret";
import { SEND_MAX_FILE_SIZE } from "@/lib/validations";

describe("SendDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("renders with Text and File tabs when open", () => {
    render(
      <SendDialog open={true} onOpenChange={() => {}} />
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent("sendText");
    expect(tabs[1]).toHaveTextContent("sendFile");
  });

  it("does not render when closed", () => {
    render(
      <SendDialog open={false} onOpenChange={() => {}} />
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows text area in text tab", () => {
    render(
      <SendDialog open={true} onOpenChange={() => {}} />
    );

    expect(screen.getByPlaceholderText("sendTextPlaceholder")).toBeInTheDocument();
  });

  it("submits text send and shows URL on success", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "s1", token: "tok", url: "/s/tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const onCreated = vi.fn();
    render(
      <SendDialog open={true} onOpenChange={() => {}} onCreated={onCreated} />
    );

    // Fill in name
    fireEvent.change(screen.getByPlaceholderText("sendNamePlaceholder"), {
      target: { value: "Test" },
    });

    // Fill in text
    fireEvent.change(screen.getByPlaceholderText("sendTextPlaceholder"), {
      target: { value: "Hello world" },
    });

    // Click create
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/sends",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("Test"),
        })
      );
    });

    mockFetch.mockRestore();
  });

  it("shows server-side encryption notice when dialog is open", () => {
    render(
      <SendDialog open={true} onOpenChange={() => {}} />
    );

    expect(screen.getByText("sendEncryptionNotice")).toBeInTheDocument();
  });

  it("shows error toast on API failure", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "VALIDATION_ERROR" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { toast } = await import("sonner");
    render(
      <SendDialog open={true} onOpenChange={() => {}} />
    );

    fireEvent.change(screen.getByPlaceholderText("sendNamePlaceholder"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByPlaceholderText("sendTextPlaceholder"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });

    mockFetch.mockRestore();
  });
});

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not rendered");
  return input;
}

function selectFile(file: File) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

function fillText(name = "Test", text = "Hello") {
  fireEvent.change(screen.getByPlaceholderText("sendNamePlaceholder"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText("sendTextPlaceholder"), { target: { value: text } });
}

function sentJson(fetchSpy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const init = fetchSpy.mock.calls[0][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("SendDialog create flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("keeps create disabled until a name and text are entered", () => {
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    const create = screen.getByRole("button", { name: "create" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("sendNamePlaceholder"), { target: { value: "   " } });
    fireEvent.change(screen.getByPlaceholderText("sendTextPlaceholder"), { target: { value: "x" } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("sendNamePlaceholder"), { target: { value: "N" } });
    expect(create).toBeEnabled();
  });

  it("sends trimmed name, chosen expiry, in-range max views and the password flag", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ url: "/s/tok" }));
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fillText("  Named  ", "body");
    fireEvent.change(screen.getByLabelText("expiresInLabel"), { target: { value: "7d" } });
    fireEvent.change(screen.getByPlaceholderText("maxViewsPlaceholder"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentJson(fetchSpy)).toEqual({
      name: "Named",
      text: "body",
      expiresIn: "7d",
      maxViews: 5,
      requirePassword: true,
    });
  });

  it("omits an out-of-range max views value from the text send", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ url: "/s/tok" }));
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fillText();
    fireEvent.change(screen.getByPlaceholderText("maxViewsPlaceholder"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentJson(fetchSpy)).toEqual({ name: "Test", text: "Hello", expiresIn: "1d" });
  });

  it("shows the share URL, notifies the parent and toasts on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ url: "/s/tok" }));
    const onCreated = vi.fn();
    render(<SendDialog open={true} onOpenChange={() => {}} onCreated={onCreated} />);
    fillText();
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    expect(await screen.findByDisplayValue(`${window.location.origin}/s/tok`)).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("sendCreateSuccess");
    expect(screen.queryByText("accessPasswordLabel")).not.toBeInTheDocument();
  });

  it("shows the generated access password with a warning when the server returns one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ url: "/s/tok", accessPassword: "pw-123" }),
    );
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fillText();
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    expect(await screen.findByDisplayValue("pw-123")).toBeInTheDocument();
    expect(screen.getByText("accessPasswordWarning")).toBeInTheDocument();
  });

  it("copies the access password through the clearing clipboard helper", async () => {
    mockCopySecret.mockResolvedValue(COPY_OUTCOME.OK);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ url: "/s/tok", accessPassword: "pw-123" }),
    );
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fillText();
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await screen.findByDisplayValue("pw-123");

    const copyButtons = screen.getAllByRole("button").filter((b) => b.textContent === "");
    fireEvent.click(copyButtons[1]);
    await waitFor(() => expect(mockCopySecret).toHaveBeenCalledTimes(1));
    const getSecret = mockCopySecret.mock.calls[0][0] as () => string;
    expect(getSecret()).toBe("pw-123");
    // onOk replaces the default success toast.
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("copies the share URL to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ url: "/s/tok" }));
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fillText();
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await screen.findByText("createAnother");

    const copyUrl = screen.getAllByRole("button").filter((b) => b.textContent === "")[0];
    fireEvent.click(copyUrl);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/s/tok`));
  });

  it("returns to an empty form on create another", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ url: "/s/tok" }));
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fillText("Keep", "content");
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    fireEvent.click(await screen.findByText("createAnother"));

    expect(screen.getByPlaceholderText("sendNamePlaceholder")).toHaveValue("");
    expect(screen.getByPlaceholderText("sendTextPlaceholder")).toHaveValue("");
    expect(screen.getByRole("button", { name: "create" })).toBeDisabled();
  });

  it("shows an unknown-error toast and keeps the form when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fillText();
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("unknownError"));
    expect(screen.getByRole("button", { name: "create" })).toBeEnabled();
    expect(screen.queryByText("createAnother")).not.toBeInTheDocument();
  });

  it("resets the form and reports close when the dialog is dismissed", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<SendDialog open={true} onOpenChange={onOpenChange} />);
    fillText("Draft", "secret");
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(<SendDialog open={false} onOpenChange={onOpenChange} />);
    rerender(<SendDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByPlaceholderText("sendNamePlaceholder")).toHaveValue("");
    expect(screen.getByPlaceholderText("sendTextPlaceholder")).toHaveValue("");
  });
});

describe("SendDialog file send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function openFileTab() {
    render(<SendDialog open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "sendFile" }));
    fireEvent.change(screen.getByPlaceholderText("sendNamePlaceholder"), { target: { value: "Doc" } });
  }

  it("keeps create disabled on the file tab until a file is chosen", () => {
    openFileTab();
    expect(screen.getByRole("button", { name: "create" })).toBeDisabled();
    selectFile(new File(["abc"], "a.txt", { type: "text/plain" }));
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "create" })).toBeEnabled();
  });

  it("rejects a file over the size limit with a toast", () => {
    openFileTab();
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: SEND_MAX_FILE_SIZE + 1 });
    selectFile(big);
    expect(toast.error).toHaveBeenCalledWith("sendFileTooLarge");
    expect(screen.queryByText("big.bin")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "create" })).toBeDisabled();
  });

  it("removes a chosen file and clears the input", () => {
    openFileTab();
    selectFile(new File(["abc"], "a.txt"));
    fireEvent.click(screen.getByRole("button", { name: "remove" }));
    expect(screen.queryByText("a.txt")).not.toBeInTheDocument();
    expect(screen.getByText("sendDropzone")).toBeInTheDocument();
    expect(fileInput().value).toBe("");
  });

  it("opens the file picker from the dropzone", () => {
    openFileTab();
    const click = vi.spyOn(fileInput(), "click");
    fireEvent.click(screen.getByText("sendDropzone"));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("posts multipart form data to the file send endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ url: "/s/ftok", accessPassword: "fpw" }),
    );
    const onCreated = vi.fn();
    render(<SendDialog open={true} onOpenChange={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("tab", { name: "sendFile" }));
    fireEvent.change(screen.getByPlaceholderText("sendNamePlaceholder"), { target: { value: " Doc " } });
    const file = new File(["abc"], "a.txt");
    selectFile(file);
    fireEvent.change(screen.getByPlaceholderText("maxViewsPlaceholder"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    expect(await screen.findByDisplayValue(`${window.location.origin}/s/ftok`)).toBeInTheDocument();
    expect(screen.getByDisplayValue("fpw")).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sends/file");
    const form = init.body as FormData;
    expect(form.get("name")).toBe("Doc");
    expect(form.get("expiresIn")).toBe("1d");
    expect(form.get("maxViews")).toBe("3");
    expect(form.get("requirePassword")).toBe("true");
    expect((form.get("file") as File).name).toBe("a.txt");
  });

  it("omits optional fields from the file form when unset", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ url: "/s/ftok" }));
    openFileTab();
    selectFile(new File(["abc"], "a.txt"));
    fireEvent.change(screen.getByPlaceholderText("maxViewsPlaceholder"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await screen.findByText("createAnother");
    const form = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.has("maxViews")).toBe(false);
    expect(form.has("requirePassword")).toBe(false);
  });

  it("toasts the API error and stays on the form when the file send is refused", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "VALIDATION_ERROR" }), { status: 400 }),
    );
    openFileTab();
    selectFile(new File(["abc"], "a.txt"));
    fireEvent.click(screen.getByRole("button", { name: "create" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByText("createAnother")).not.toBeInTheDocument();
  });

  it("shows an unknown-error toast when the file request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    openFileTab();
    selectFile(new File(["abc"], "a.txt"));
    fireEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("unknownError"));
  });
});
