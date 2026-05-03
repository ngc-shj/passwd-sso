// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AuditDateFilter } from "./audit-date-filter";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("AuditDateFilter", () => {
  it("renders both From and To labels and date inputs with their values", () => {
    const { container } = render(
      <AuditDateFilter
        dateFrom="2024-01-01"
        dateTo="2024-12-31"
        setDateFrom={vi.fn()}
        setDateTo={vi.fn()}
      />,
    );
    expect(screen.getByText("dateFrom")).toBeInTheDocument();
    expect(screen.getByText("dateTo")).toBeInTheDocument();
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe("2024-01-01");
    expect(inputs[1].value).toBe("2024-12-31");
  });

  it("invokes setDateFrom on the first input change", () => {
    const setDateFrom = vi.fn();
    const { container } = render(
      <AuditDateFilter
        dateFrom=""
        dateTo=""
        setDateFrom={setDateFrom}
        setDateTo={vi.fn()}
      />,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    fireEvent.change(inputs[0], { target: { value: "2024-06-15" } });
    expect(setDateFrom).toHaveBeenCalledWith("2024-06-15");
  });

  it("invokes setDateTo on the second input change", () => {
    const setDateTo = vi.fn();
    const { container } = render(
      <AuditDateFilter
        dateFrom=""
        dateTo=""
        setDateFrom={vi.fn()}
        setDateTo={setDateTo}
      />,
    );
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    fireEvent.change(inputs[1], { target: { value: "2025-01-31" } });
    expect(setDateTo).toHaveBeenCalledWith("2025-01-31");
  });
});
