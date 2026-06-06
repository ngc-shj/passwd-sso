// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MasterDetailShell } from "./master-detail-shell";

const ListSlot = () => <div data-testid="list-slot">List</div>;
const DetailSlot = () => <div data-testid="detail-slot">Detail</div>;

describe("MasterDetailShell", () => {
  it("master-detail mode: renders both listSlot and detailSlot (INV-C5.1)", () => {
    render(
      <MasterDetailShell
        listSlot={<ListSlot />}
        detailSlot={<DetailSlot />}
        layoutMode="master-detail"
        activeEntryId={null}
      />,
    );

    expect(screen.getByTestId("list-slot")).toBeInTheDocument();
    expect(screen.getByTestId("detail-slot")).toBeInTheDocument();

    // Both regions have the master-detail container testids
    expect(screen.getByTestId("master-detail-list")).toContainElement(
      screen.getByTestId("list-slot"),
    );
    expect(screen.getByTestId("master-detail-detail")).toContainElement(
      screen.getByTestId("detail-slot"),
    );
  });

  it("master-detail mode: list and detail are siblings in a flex row (separate scroll regions, INV-C5.1)", () => {
    const { container } = render(
      <MasterDetailShell
        listSlot={<ListSlot />}
        detailSlot={<DetailSlot />}
        layoutMode="master-detail"
        activeEntryId="entry-1"
      />,
    );

    const root = container.firstChild as HTMLElement;
    // Root is a flex container
    expect(root.className).toContain("flex");
    // List and detail are direct children of the flex container (siblings)
    const list = screen.getByTestId("master-detail-list");
    const detail = screen.getByTestId("master-detail-detail");
    expect(list.parentElement).toBe(root);
    expect(detail.parentElement).toBe(root);
  });

  it("master-detail mode: does NOT apply max-w-4xl centering (INV-C5.2)", () => {
    const { container } = render(
      <MasterDetailShell
        listSlot={<ListSlot />}
        detailSlot={<DetailSlot />}
        layoutMode="master-detail"
        activeEntryId={null}
      />,
    );

    // max-w-4xl must not appear anywhere in the master-detail layout
    expect(container.innerHTML).not.toContain("max-w-4xl");
  });

  it("accordion mode: renders only listSlot (not detailSlot)", () => {
    render(
      <MasterDetailShell
        listSlot={<ListSlot />}
        detailSlot={<DetailSlot />}
        layoutMode="accordion"
        activeEntryId={null}
      />,
    );

    expect(screen.getByTestId("list-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-slot")).not.toBeInTheDocument();
  });

  it("accordion mode: applies max-w-4xl centering wrapper (INV-C5.2)", () => {
    const { container } = render(
      <MasterDetailShell
        listSlot={<ListSlot />}
        detailSlot={<DetailSlot />}
        layoutMode="accordion"
        activeEntryId={null}
      />,
    );

    // The accordion wrapper must have the max-w-4xl class
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("max-w-4xl");
  });

  it("accordion mode: does NOT render the master-detail pane testids", () => {
    render(
      <MasterDetailShell
        listSlot={<ListSlot />}
        detailSlot={<DetailSlot />}
        layoutMode="accordion"
        activeEntryId={null}
      />,
    );

    expect(screen.queryByTestId("master-detail-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("master-detail-detail")).not.toBeInTheDocument();
  });
});
