// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { mockUseLocale } = vi.hoisted(() => ({
  mockUseLocale: vi.fn(() => "en"),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => mockUseLocale(),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id: string;
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
  }) => (
    <input
      id={id}
      role="switch"
      type="checkbox"
      aria-checked={checked}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

import { AutoMonitorToggle } from "./auto-monitor-toggle";

describe("AutoMonitorToggle", () => {
  beforeEach(() => {
    mockUseLocale.mockReturnValue("en");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders label, description, and switch", () => {
    render(
      <AutoMonitorToggle enabled={false} onToggle={vi.fn()} lastCheckAt={null} />,
    );

    expect(screen.getByText("autoMonitorLabel")).toBeInTheDocument();
    expect(screen.getByText("autoMonitorDescription")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("does not show lastCheckAt line when null", () => {
    render(
      <AutoMonitorToggle enabled={false} onToggle={vi.fn()} lastCheckAt={null} />,
    );
    expect(screen.queryByText(/lastAutoCheck/)).toBeNull();
  });

  it("shows 'just now' when lastCheckAt is < 1 minute ago (English)", () => {
    const ts = Date.now() - 30_000;
    render(
      <AutoMonitorToggle enabled={true} onToggle={vi.fn()} lastCheckAt={ts} />,
    );
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  it("shows minutes ago for sub-hour delta (English)", () => {
    const ts = Date.now() - 5 * 60_000;
    render(
      <AutoMonitorToggle enabled={true} onToggle={vi.fn()} lastCheckAt={ts} />,
    );
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
  });

  it("shows hours ago for sub-day delta (English)", () => {
    const ts = Date.now() - 3 * 3_600_000;
    render(
      <AutoMonitorToggle enabled={true} onToggle={vi.fn()} lastCheckAt={ts} />,
    );
    expect(screen.getByText(/3h ago/)).toBeInTheDocument();
  });

  it("shows days ago for >= 24h delta (English)", () => {
    const ts = Date.now() - 48 * 3_600_000;
    render(
      <AutoMonitorToggle enabled={true} onToggle={vi.fn()} lastCheckAt={ts} />,
    );
    expect(screen.getByText(/2d ago/)).toBeInTheDocument();
  });

  it("uses Japanese formatting when locale is ja", () => {
    mockUseLocale.mockReturnValue("ja");
    const ts = Date.now() - 30_000;
    render(
      <AutoMonitorToggle enabled={true} onToggle={vi.fn()} lastCheckAt={ts} />,
    );
    expect(screen.getByText(/たった今/)).toBeInTheDocument();
  });

  it("calls onToggle when switch is toggled", () => {
    const onToggle = vi.fn();
    render(
      <AutoMonitorToggle enabled={false} onToggle={onToggle} lastCheckAt={null} />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
