// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

describe("DropdownMenu", () => {
  it("opens the menu from the trigger and renders items", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Label</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuItem>
            Item 2<DropdownMenuShortcut>⌘2</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.queryByText("Item 1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Menu" }));

    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
    expect(screen.getByText("⌘2")).toBeInTheDocument();
  });

  it("invokes onSelect when an item is activated", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>Pick</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("menuitem", { name: "Pick" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders an item with the destructive variant", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("button", { name: "Menu" }));

    expect(screen.getByText("Delete")).toHaveAttribute(
      "data-variant",
      "destructive",
    );
  });

  it("defaults items to the default variant and forwards inset and className", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem inset className="extra-item">Plain</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const item = screen.getByRole("menuitem", { name: "Plain" });
    expect(item).toHaveAttribute("data-slot", "dropdown-menu-item");
    expect(item).toHaveAttribute("data-variant", "default");
    expect(item).toHaveAttribute("data-inset", "true");
    expect(item).toHaveClass("extra-item", "data-[inset]:pl-8");
  });

  it("tags the trigger and content with their slots and merges the content className", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent className="extra-content">
          <DropdownMenuGroup>
            <DropdownMenuItem>Grouped</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    // The open modal menu hides the rest of the page from the accessibility tree.
    expect(screen.getByRole("button", { name: "Menu", hidden: true })).toHaveAttribute(
      "data-slot",
      "dropdown-menu-trigger",
    );
    const content = screen.getByRole("menu");
    expect(content).toHaveAttribute("data-slot", "dropdown-menu-content");
    expect(content).toHaveClass("extra-content", "bg-popover");
    expect(screen.getByRole("group")).toHaveAttribute("data-slot", "dropdown-menu-group");
  });

  it("marks labels as inset and tags separators and shortcuts with their slots", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel inset>Section</DropdownMenuLabel>
          <DropdownMenuSeparator className="extra-sep" />
          <DropdownMenuItem>
            Copy<DropdownMenuShortcut className="extra-kbd">⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const label = screen.getByText("Section");
    expect(label).toHaveAttribute("data-slot", "dropdown-menu-label");
    expect(label).toHaveAttribute("data-inset", "true");
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("data-slot", "dropdown-menu-separator");
    expect(separator).toHaveClass("extra-sep", "bg-border");
    const shortcut = screen.getByText("⌘C");
    expect(shortcut).toHaveAttribute("data-slot", "dropdown-menu-shortcut");
    expect(shortcut).toHaveClass("extra-kbd", "ml-auto");
  });

  it("forwards checked state to a checkbox item and reports changes", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked onCheckedChange={onCheckedChange}>
            Show hidden
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const item = screen.getByRole("menuitemcheckbox", { name: "Show hidden" });
    expect(item).toHaveAttribute("data-slot", "dropdown-menu-checkbox-item");
    expect(item).toHaveAttribute("aria-checked", "true");

    await user.click(item);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("selects radio items within a radio group", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="a" onValueChange={onValueChange}>
            <DropdownMenuRadioItem value="a">Alpha</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">Beta</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const alpha = screen.getByRole("menuitemradio", { name: "Alpha" });
    expect(alpha).toHaveAttribute("data-slot", "dropdown-menu-radio-item");
    expect(alpha).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Beta" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    await user.click(screen.getByRole("menuitemradio", { name: "Beta" }));
    expect(onValueChange).toHaveBeenCalledWith("b");
  });

  it("opens a submenu from its inset trigger and tags the parts with their slots", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="extra-sub">
                <DropdownMenuItem>Nested</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const subTrigger = screen.getByRole("menuitem", { name: "More" });
    expect(subTrigger).toHaveAttribute("data-slot", "dropdown-menu-sub-trigger");
    expect(subTrigger).toHaveAttribute("data-inset", "true");
    expect(screen.queryByText("Nested")).not.toBeInTheDocument();

    await user.click(subTrigger);

    expect(await screen.findByText("Nested")).toBeInTheDocument();
    const subContent = screen.getByText("Nested").closest('[data-slot="dropdown-menu-sub-content"]');
    expect(subContent).toHaveClass("extra-sub", "shadow-lg");
  });
});

