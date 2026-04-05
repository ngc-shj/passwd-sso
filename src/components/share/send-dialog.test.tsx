// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
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
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
  TabsTrigger: ({
    children,
    value,
    ...rest
  }: { children: React.ReactNode; value: string } & React.ComponentProps<"button">) => (
    <button role="tab" data-value={value} {...rest}>{children}</button>
  ),
  TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div role="tabpanel" data-value={value}>{children}</div>
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({ checked, onCheckedChange, ...rest }: { checked: boolean; onCheckedChange: (v: boolean) => void } & React.ComponentProps<"button">) => (
    <button role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} {...rest} />
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api-error-codes", () => ({
  apiErrorToI18nKey: (e: string) => e,
}));

vi.mock("@/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...actual,
    API_PATH: {
      SENDS: "/api/sends",
      SENDS_FILE: "/api/sends/file",
    },
  };
});

vi.mock("@/lib/validations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/validations")>();
  return { ...actual };
});

import { SendDialog } from "./send-dialog";

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
