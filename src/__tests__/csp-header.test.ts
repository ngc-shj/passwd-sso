import { describe, it, expect } from "vitest";
import { buildCspHeader } from "../lib/security/csp-builder";

// These tests pin the loopback host literals in the CSP `form-action`
// directive against accidental removal. The directive MUST mirror DCR's
// LOOPBACK_REDIRECT_RE accept set (see src/lib/constants/auth/mcp.ts) —
// any host accepted by the regex but missing here causes the OAuth
// consent-form 302 redirect to be CSP-blocked after the audit log has
// already been written.

describe("buildCspHeader — form-action loopback hosts", () => {
  const NONCE = "test-nonce-12345";
  const csp = buildCspHeader(NONCE);

  it("allows form submissions to same origin", () => {
    expect(csp).toContain("form-action 'self'");
  });

  it("allows http://localhost:* for OAuth loopback redirects", () => {
    expect(csp).toMatch(/form-action[^;]*\bhttp:\/\/localhost:\*/);
  });

  it("allows http://127.0.0.1:* for OAuth loopback redirects (RFC 8252 §7.3)", () => {
    expect(csp).toMatch(/form-action[^;]*\bhttp:\/\/127\.0\.0\.1:\*/);
  });

  it("allows http://[::1]:* for IPv6 OAuth loopback redirects (RFC 8252 §7.3)", () => {
    expect(csp).toMatch(/form-action[^;]*http:\/\/\[::1\]:\*/);
  });

  it("does NOT allow non-loopback HTTP form targets in form-action", () => {
    // Sanity check: no broad http:* or arbitrary http hosts in form-action.
    const formActionMatch = csp.match(/form-action[^;]*/);
    expect(formActionMatch).not.toBeNull();
    const formAction = formActionMatch![0];
    expect(formAction).not.toMatch(/\bhttp:\*/);
    expect(formAction).not.toContain("http://example.com");
  });
});
