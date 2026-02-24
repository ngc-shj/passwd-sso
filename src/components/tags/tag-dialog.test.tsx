// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...rest }: React.ComponentProps<"button">) => <button {...rest}>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ ...rest }: React.ComponentProps<"input">) => <input {...rest} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...rest }: React.ComponentProps<"label">) => <label {...rest}>{children}</label>,
}));

import { TagDialog } from "./tag-dialog";

describe("TagDialog", () => {
  it("initializes fields from editTag", () => {
    render(
      <TagDialog
        open
        onOpenChange={() => {}}
        editTag={{ id: "t1", name: "Ops", color: "#112233" }}
        onSubmit={async () => {}}
      />
    );

    expect(screen.getByLabelText("tagName")).toHaveValue("Ops");
    expect(screen.getByLabelText("tagColor")).toHaveValue("#112233");
  });

  it("keeps null color when original color is null and unchanged", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <TagDialog
        open
        onOpenChange={() => {}}
        editTag={{ id: "t1", name: "Ops", color: null }}
        onSubmit={onSubmit}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ name: "Ops", color: null });
  });

  it("submits updated color when user changes color input", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <TagDialog
        open
        onOpenChange={() => {}}
        editTag={{ id: "t1", name: "Ops", color: null }}
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByLabelText("tagColor"), { target: { value: "#abcdef" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ name: "Ops", color: "#abcdef" });
  });

  it("closes dialog on successful submit", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <TagDialog
        open
        onOpenChange={onOpenChange}
        editTag={{ id: "t1", name: "Ops", color: null }}
        onSubmit={onSubmit}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps dialog open on submit failure", async () => {
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error("API error"));

    render(
      <TagDialog
        open
        onOpenChange={onOpenChange}
        editTag={{ id: "t1", name: "Ops", color: null }}
        onSubmit={onSubmit}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
    });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("renders create mode when editTag is null", () => {
    render(
      <TagDialog
        open
        onOpenChange={() => {}}
        editTag={null}
        onSubmit={async () => {}}
      />
    );

    expect(screen.getByText("createTag")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "create" })).toBeInTheDocument();
    expect(screen.getByLabelText("tagName")).toHaveValue("");
  });

  it("submits new tag in create mode", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <TagDialog
        open
        onOpenChange={() => {}}
        editTag={null}
        onSubmit={onSubmit}
      />
    );

    fireEvent.change(screen.getByLabelText("tagName"), { target: { value: "New Tag" } });
    fireEvent.change(screen.getByLabelText("tagColor"), { target: { value: "#aabbcc" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "create" }));
    });

    expect(onSubmit).toHaveBeenCalledWith({ name: "New Tag", color: "#aabbcc" });
  });
});
