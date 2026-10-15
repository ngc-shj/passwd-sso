// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useClientSnapshot } from "./use-client-snapshot";

function Probe() {
  const value = useClientSnapshot(() => "client", "server");
  return <span data-testid="value">{value}</span>;
}

describe("useClientSnapshot", () => {
  it("renders the server value on the server", () => {
    expect(renderToString(<Probe />)).toContain("server");
  });

  it("renders the browser snapshot on a client render", () => {
    render(<Probe />);
    expect(screen.getByTestId("value").textContent).toBe("client");
  });
});
