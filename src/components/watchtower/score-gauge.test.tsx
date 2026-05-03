// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ScoreGauge } from "./score-gauge";

describe("ScoreGauge", () => {
  it("renders score number and label", () => {
    render(<ScoreGauge score={75} label="Security Score" />);
    expect(screen.getByText("75")).toBeInTheDocument();
    expect(screen.getByText("Security Score")).toBeInTheDocument();
  });

  it("uses green color for score >= 71", () => {
    const { container } = render(<ScoreGauge score={80} label="ok" />);
    // The progress circle (second circle) gets stroke=color
    const circles = container.querySelectorAll("circle");
    expect(circles[1].getAttribute("stroke")).toBe("#22c55e");
  });

  it("uses yellow color for score in 41..70", () => {
    const { container } = render(<ScoreGauge score={50} label="ok" />);
    const circles = container.querySelectorAll("circle");
    expect(circles[1].getAttribute("stroke")).toBe("#eab308");
  });

  it("uses red color for score < 41", () => {
    const { container } = render(<ScoreGauge score={20} label="ok" />);
    const circles = container.querySelectorAll("circle");
    expect(circles[1].getAttribute("stroke")).toBe("#ef4444");
  });

  it("clamps score below 0 to draw 0% progress (offset == circumference)", () => {
    const { container } = render(<ScoreGauge score={-5} size={100} label="ok" />);
    const progressCircle = container.querySelectorAll("circle")[1];
    const dashArray = Number(progressCircle.getAttribute("stroke-dasharray"));
    const dashOffset = Number(progressCircle.getAttribute("stroke-dashoffset"));
    expect(dashOffset).toBeCloseTo(dashArray);
  });

  it("clamps score above 100 to draw full progress (offset == 0)", () => {
    const { container } = render(<ScoreGauge score={150} size={100} label="ok" />);
    const dashOffset = Number(
      container.querySelectorAll("circle")[1].getAttribute("stroke-dashoffset"),
    );
    expect(dashOffset).toBeCloseTo(0);
  });

  it("renders an accessible svg with aria-label including the score", () => {
    render(<ScoreGauge score={42} label="Risk" />);
    expect(screen.getByRole("img", { name: "Score 42" })).toBeInTheDocument();
  });
});
