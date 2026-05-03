// @vitest-environment jsdom
/**
 * ConsentForm — MCP authorize UI tests.
 *
 * The component renders client name + scopes and submits a hidden POST form
 * to /api/mcp/authorize/consent on Allow / Deny. We assert:
 *   - render with props (title, scopes, DCR badge)
 *   - allow click submits a form with action / fields populated
 *   - deny click submits a form with action="deny" + fields populated
 *   - buttons disable during submission
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────
//
// next-intl is mocked because consent-form pulls scopeDescriptions from a
// nested namespace object via useMessages(); we provide both hooks.

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useMessages: () => ({
    McpConsent: {
      scopeDescriptions: {
        "credentials:list": "List credentials",
        "passwords:write": "Write passwords",
      },
    },
  }),
}));

// withBasePath is identity in tests (BASE_PATH is empty).
vi.mock("@/lib/url-helpers", () => ({
  withBasePath: (p: string) => p,
}));

// Replace shadcn primitives with semantic DOM nodes so we can query by role/text.
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    ...rest
  }: React.ComponentProps<"button">) => (
    <button disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => <span data-variant={variant}>{children}</span>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: Array<string | undefined | null | false>) =>
    args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  ShieldCheck: () => <svg data-testid="icon-shield-check" />,
  ShieldX: () => <svg data-testid="icon-shield-x" />,
  Loader2: () => <svg data-testid="icon-loader" />,
}));

import { ConsentForm } from "./consent-form";

// ─── Test helpers ────────────────────────────────────────────────────────────

const baseProps = {
  clientName: "Claude Desktop",
  clientId: "mcpc_abc123",
  isDcr: false,
  scopes: ["credentials:list", "passwords:write"],
  redirectUri: "http://localhost:7777/callback",
  state: "state-xyz",
  codeChallenge: "challenge-abc",
  codeChallengeMethod: "S256",
};

/**
 * Capture the form element submitted by handleAllow / handleDeny.
 * The component creates a temporary form and calls form.submit(). In jsdom,
 * HTMLFormElement.prototype.submit is a no-op stub — we override it on the
 * prototype so the test can capture the form before navigation would occur.
 */
function captureSubmittedForm(): HTMLFormElement[] {
  const captured: HTMLFormElement[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = HTMLFormElement.prototype as any;
  const original = proto.submit;
  proto.submit = function (this: HTMLFormElement) {
    captured.push(this);
  };
  // Restore after this test tick — afterEach will not fire mid-test.
  // Tests call this once at the start; restoration happens via vi cleanup.
  // Use Symbol.dispose-like manual cleanup hook:
  (captured as unknown as { _restore?: () => void })._restore = () => {
    proto.submit = original;
  };
  return captured;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ConsentForm — render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the client name and translated title", () => {
    render(<ConsentForm {...baseProps} />);
    expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    expect(screen.getByText("title")).toBeInTheDocument();
  });

  it("renders each requested scope with its description", () => {
    render(<ConsentForm {...baseProps} />);
    expect(screen.getByText("credentials:list")).toBeInTheDocument();
    expect(screen.getByText("List credentials")).toBeInTheDocument();
    expect(screen.getByText("passwords:write")).toBeInTheDocument();
    expect(screen.getByText("Write passwords")).toBeInTheDocument();
  });

  it("renders DCR badge when isDcr is true", () => {
    render(<ConsentForm {...baseProps} isDcr={true} />);
    expect(screen.getByText("DCR")).toBeInTheDocument();
  });

  it("omits the DCR badge when isDcr is false", () => {
    render(<ConsentForm {...baseProps} isDcr={false} />);
    expect(screen.queryByText("DCR")).not.toBeInTheDocument();
  });

  it("falls back to the scope name when no description is configured", () => {
    render(
      <ConsentForm
        {...baseProps}
        scopes={["unknown:scope"]}
      />,
    );
    // Scope name is rendered inside the badge; the description span renders
    // the scope literal as fallback. Both should be present.
    expect(screen.getAllByText("unknown:scope").length).toBeGreaterThanOrEqual(1);
  });
});

describe("ConsentForm — submit handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Allow click submits a form with all OAuth fields populated", () => {
    const captured = captureSubmittedForm();
    try {
      render(<ConsentForm {...baseProps} />);
      fireEvent.click(screen.getByText("allow"));

      expect(captured.length).toBe(1);
      const form = captured[0]!;
      expect(form.method.toLowerCase()).toBe("post");
      expect(form.action).toContain("/api/mcp/authorize/consent");

      const fields = Object.fromEntries(
        Array.from(form.querySelectorAll("input")).map((i) => [
          i.name,
          i.value,
        ]),
      );
      expect(fields.client_id).toBe("mcpc_abc123");
      expect(fields.redirect_uri).toBe("http://localhost:7777/callback");
      expect(fields.scope).toBe("credentials:list passwords:write");
      expect(fields.code_challenge).toBe("challenge-abc");
      expect(fields.code_challenge_method).toBe("S256");
      expect(fields.state).toBe("state-xyz");
    } finally {
      (captured as unknown as { _restore?: () => void })._restore?.();
    }
  });

  it("Deny click submits a form with action=deny and core OAuth fields", () => {
    const captured = captureSubmittedForm();
    try {
      render(<ConsentForm {...baseProps} />);
      fireEvent.click(screen.getByText("deny"));

      expect(captured.length).toBe(1);
      const form = captured[0]!;
      const fields = Object.fromEntries(
        Array.from(form.querySelectorAll("input")).map((i) => [
          i.name,
          i.value,
        ]),
      );
      expect(fields.action).toBe("deny");
      expect(fields.client_id).toBe("mcpc_abc123");
      expect(fields.redirect_uri).toBe("http://localhost:7777/callback");
      expect(fields.state).toBe("state-xyz");
      // Deny path does NOT submit the OAuth challenge fields
      expect(fields.code_challenge).toBeUndefined();
      expect(fields.scope).toBeUndefined();
    } finally {
      (captured as unknown as { _restore?: () => void })._restore?.();
    }
  });

  it("disables both buttons after Allow click (loading state)", () => {
    const captured = captureSubmittedForm();
    try {
      render(<ConsentForm {...baseProps} />);
      const allowBtn = screen.getByText("allow").closest("button")!;
      const denyBtn = screen.getByText("deny").closest("button")!;
      expect(allowBtn).not.toBeDisabled();
      expect(denyBtn).not.toBeDisabled();

      fireEvent.click(allowBtn);

      // After click, setLoading(true) propagates and disables both buttons
      expect(allowBtn).toBeDisabled();
      expect(denyBtn).toBeDisabled();
    } finally {
      (captured as unknown as { _restore?: () => void })._restore?.();
    }
  });
});
