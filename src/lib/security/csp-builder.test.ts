/**
 * CSP header construction tests.
 *
 * Note: csp-builder.ts captures NODE_ENV / CSP_MODE / NEXT_PUBLIC_BASE_PATH /
 * NEXT_PUBLIC_SENTRY_DSN at MODULE INIT time, so per-test env stubbing has
 * no effect once the module is loaded by setup.ts. To verify mode-dependent
 * branches, we use dynamic imports with `vi.resetModules()` between cases.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("csp-builder", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("buildCspHeader (default test env — dev mode)", () => {
    it("includes default-src 'self'", async () => {
      const { buildCspHeader } = await import("./csp-builder");
      expect(buildCspHeader("nonce-abc")).toContain("default-src 'self'");
    });

    it("dev script-src uses unsafe-inline + unsafe-eval (no nonce)", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CSP_MODE", "dev");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce-abc");
      expect(header).toContain(
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
      );
      expect(header).not.toContain("nonce-abc");
    });

    it("dev style-src uses unsafe-inline (no nonce)", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CSP_MODE", "dev");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce-xyz");
      expect(header).toContain("style-src 'self' 'unsafe-inline'");
    });
  });

  describe("buildCspHeader — strict mode", () => {
    it("strict script-src injects nonce + strict-dynamic", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CSP_MODE", "strict");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("rnd-nonce-123");
      expect(header).toContain(
        "script-src 'self' 'nonce-rnd-nonce-123' 'strict-dynamic' 'wasm-unsafe-eval'",
      );
    });

    it("strict script-src does NOT contain unsafe-eval", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CSP_MODE", "strict");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("rnd-nonce-123");
      expect(header).not.toContain("'unsafe-eval'");
      // 'wasm-unsafe-eval' is fine — explicitly tested above.
    });

    it("strict style-src injects per-request nonce", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CSP_MODE", "strict");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("rnd-nonce-456");
      expect(header).toContain("style-src 'self' 'nonce-rnd-nonce-456'");
    });

    it("different per-request nonces produce different headers (no caching)", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CSP_MODE", "strict");
      const { buildCspHeader } = await import("./csp-builder");
      const a = buildCspHeader("nonce-A");
      const b = buildCspHeader("nonce-B");
      expect(a).not.toBe(b);
      expect(a).toContain("nonce-A");
      expect(b).toContain("nonce-B");
    });
  });

  describe("buildCspHeader — production downgrade guard", () => {
    it("ignores CSP_MODE=dev in production (forces strict)", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CSP_MODE", "dev");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("p-nonce");

      // Should be strict despite CSP_MODE=dev
      expect(header).toContain("'strict-dynamic'");
      expect(header).not.toContain("'unsafe-inline'");
      expect(header).toContain("nonce-p-nonce");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('CSP_MODE="dev" is ignored in production builds'),
      );
      warn.mockRestore();
    });
  });

  describe("buildCspHeader — static directives", () => {
    it("contains required deny-by-default directives", async () => {
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain("img-src 'self' data: https:");
      expect(header).toContain("font-src 'self'");
      expect(header).toContain("object-src 'none'");
      expect(header).toContain("base-uri 'self'");
      expect(header).toContain("frame-ancestors 'none'");
      expect(header).toContain("upgrade-insecure-requests");
      // M2 defense-in-depth: pin worker-src so a future default-src widen
      // can't accidentally let WASM-in-Worker load cross-origin.
      expect(header).toContain("worker-src 'self'");
    });

    it("form-action allows self plus loopback wildcards (RFC 8252)", async () => {
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain(
        "form-action 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*",
      );
    });

    it("A05-2: loopback wildcards stay scoped to form-action (no leak to other directives)", async () => {
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      // Every directive that should NOT receive loopback wildcards. If a
      // future refactor accidentally widens connect-src / script-src / etc.
      // to the loopback-everywhere set, this test catches it before merge.
      for (const directive of [
        "connect-src",
        "script-src",
        "style-src",
        "img-src",
        "frame-src",
        "frame-ancestors",
        "default-src",
      ]) {
        // Match e.g. "connect-src ... http://localhost:* ..." — should NOT appear.
        const re = new RegExp(`${directive}[^;]*http://localhost:\\*`);
        expect(header).not.toMatch(re);
      }
    });

    it("includes report-to and report-uri directives", async () => {
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain("report-to csp-endpoint");
      expect(header).toContain("report-uri /api/csp-report");
    });
  });

  describe("buildCspHeader — Sentry connect-src", () => {
    it("connect-src is 'self' only when SENTRY_DSN is unset", async () => {
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain("connect-src 'self';");
      expect(header).not.toContain("ingest");
    });

    // L2: narrow connect-src from `https://*.ingest.{us.,}sentry.io`
    // (whole Sentry infrastructure) to the exact org-ingest host derived
    // from the DSN. A compromised or attacker-registered sibling
    // subdomain of sentry.io is now blocked by CSP.
    it("L2: connect-src pins to the DSN's exact ingest host (no wildcard)", async () => {
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://abc@o123.ingest.sentry.io/1");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain("https://o123.ingest.sentry.io");
      expect(header).not.toContain("*.ingest");
    });

    it("L2: works for the us regional ingest host", async () => {
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://abc@o456.ingest.us.sentry.io/2");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain("https://o456.ingest.us.sentry.io");
      expect(header).not.toContain("*.ingest");
    });

    it("L2: falls back to broad wildcard on malformed DSN (fail-open)", async () => {
      // A malformed DSN must not silently disable Sentry — the operator
      // would notice broken error capture and miss real prod issues. The
      // wider CSP surface is the accepted fail-open.
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "not-a-valid-url");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain("https://*.ingest.us.sentry.io");
      expect(header).toContain("https://*.ingest.sentry.io");
    });
  });

  describe("buildCspHeader — base path", () => {
    it("report-uri respects NEXT_PUBLIC_BASE_PATH", async () => {
      vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/sso");
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      expect(header).toContain("report-uri /sso/api/csp-report");
    });
  });

  describe("buildCspHeader — directive separator", () => {
    it("uses '; ' between directives", async () => {
      const { buildCspHeader } = await import("./csp-builder");
      const header = buildCspHeader("nonce");
      // Must split into multiple non-empty directives
      const parts = header.split("; ").map((p) => p.trim()).filter(Boolean);
      expect(parts.length).toBeGreaterThan(5);
    });
  });
});
