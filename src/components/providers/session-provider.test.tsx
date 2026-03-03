// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const { mockSessionProvider } = vi.hoisted(() => ({
  mockSessionProvider: vi.fn(({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  )),
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: mockSessionProvider,
}));

vi.mock("@/lib/constants", () => ({
  API_PATH: { API_ROOT: "/api" },
}));

import { SessionProvider } from "./session-provider";

describe("SessionProvider", () => {
  it("passes basePath with NEXT_PUBLIC_BASE_PATH prefix to NextAuthSessionProvider", () => {
    render(
      <SessionProvider>
        <div>child</div>
      </SessionProvider>,
    );

    expect(mockSessionProvider).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (mockSessionProvider.mock.calls as any[])[0][0];
    const envBasePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(
      /\/$/,
      "",
    );
    expect(props.basePath).toBe(`${envBasePath}/api/auth`);
  });

  it("defaults basePath to /api/auth when NEXT_PUBLIC_BASE_PATH is empty", () => {
    if (!process.env.NEXT_PUBLIC_BASE_PATH) {
      render(
        <SessionProvider>
          <div>child</div>
        </SessionProvider>,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const props = (mockSessionProvider.mock.calls as any[])[0][0];
      expect(props.basePath).toBe("/api/auth");
    }
  });
});
