// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";

// Hoisted Sentry mock
const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: sentryMocks.captureException,
}));

import GlobalError from "./global-error";

describe("GlobalError", () => {
  const error = new Error("test error");
  const reset = vi.fn();

  beforeEach(() => {
    sentryMocks.captureException.mockClear();
    reset.mockClear();
  });

  it("renders without crashing", () => {
    render(<GlobalError error={error} reset={reset} />);
    // Should render a retry button
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("calls captureException with the error when NEXT_PUBLIC_SENTRY_DSN is set", async () => {
    const original = process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://fake@sentry.io/123";

    render(<GlobalError error={error} reset={reset} />);

    // Wait for useEffect to fire
    await vi.waitFor(() => {
      expect(sentryMocks.captureException).toHaveBeenCalledOnce();
      // Argument is a sanitized copy, not the original error object
      const arg = sentryMocks.captureException.mock.calls[0][0];
      expect(arg).toBeInstanceOf(Error);
      expect(arg.message).toBe(error.message);
    });

    process.env.NEXT_PUBLIC_SENTRY_DSN = original;
  });

  it("does not call captureException when NEXT_PUBLIC_SENTRY_DSN is not set", async () => {
    const original = process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;

    render(<GlobalError error={error} reset={reset} />);

    // Give useEffect time to run
    await new Promise((r) => setTimeout(r, 10));

    expect(sentryMocks.captureException).not.toHaveBeenCalled();

    process.env.NEXT_PUBLIC_SENTRY_DSN = original;
  });

  it("calls reset when the retry button is clicked", async () => {
    const user = userEvent.setup();
    render(<GlobalError error={error} reset={reset} />);

    await user.click(screen.getByRole("button"));
    expect(reset).toHaveBeenCalledOnce();
  });
});
