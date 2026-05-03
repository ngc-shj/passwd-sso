import { describe, it, expect } from "vitest";
import {
  classifyRoute,
  isApiRoute,
  ROUTE_POLICY_KIND,
  type RoutePolicyKind,
} from "./route-policy";

type ClassifyCase = {
  pathname: string;
  description: string;
};

// Type-driven exhaustiveness gate: this `Record<RoutePolicyKind, ...>` will
// fail TypeScript compilation if a `RoutePolicyKind` value is added without
// adding a positive test case here. To verify, temporarily remove an entry
// (e.g. `[ROUTE_POLICY_KIND.API_V1]`) and run `npx tsc --noEmit` — the missing
// key MUST surface as a TS error pointing back to this file.
const POSITIVE_CASES: Record<RoutePolicyKind, readonly ClassifyCase[]> = {
  [ROUTE_POLICY_KIND.PREFLIGHT]: [
    // PREFLIGHT is method-driven (handled by api-route.ts before classify); the
    // pure classifier never returns it. This empty list is the contract: the
    // kind exists in the union, but classifyRoute does not own it.
  ],
  [ROUTE_POLICY_KIND.PUBLIC_SHARE]: [
    { pathname: "/api/share-links/verify-access", description: "exact verify-access" },
    { pathname: "/api/share-links/abc123/content", description: "content endpoint" },
    { pathname: "/api/share-links/some-uuid-123/content", description: "uuid id" },
  ],
  [ROUTE_POLICY_KIND.PUBLIC_RECEIVER]: [
    { pathname: "/api/csp-report", description: "exact csp-report" },
  ],
  [ROUTE_POLICY_KIND.API_V1]: [
    { pathname: "/api/v1/passwords", description: "v1 list" },
    { pathname: "/api/v1/vault/status", description: "v1 vault status" },
    { pathname: "/api/v1/openapi.json", description: "v1 openapi spec" },
  ],
  [ROUTE_POLICY_KIND.API_EXTENSION_EXCHANGE]: [
    { pathname: "/api/extension/token/exchange", description: "exact exchange" },
  ],
  [ROUTE_POLICY_KIND.API_SESSION_REQUIRED]: [
    { pathname: "/api/passwords", description: "passwords prefix" },
    { pathname: "/api/teams/team-1", description: "teams prefix" },
    { pathname: "/api/vault/setup", description: "vault prefix" },
    { pathname: "/api/folders", description: "folders prefix" },
    { pathname: "/api/notifications", description: "notifications prefix" },
    { pathname: "/api/extension/bridge-code", description: "extension non-token-exchange" },
  ],
  [ROUTE_POLICY_KIND.API_DEFAULT]: [
    { pathname: "/api/auth/session", description: "auth session" },
    { pathname: "/api/internal/audit-emit", description: "internal audit" },
    { pathname: "/api/maintenance/purge-history", description: "maintenance" },
    { pathname: "/api/scim/v2/Users", description: "scim (route-handler auth)" },
    { pathname: "/api/admin/rotate-master-key", description: "admin" },
  ],
  [ROUTE_POLICY_KIND.PAGE]: [
    { pathname: "/", description: "root" },
    { pathname: "/dashboard", description: "dashboard root" },
    { pathname: "/ja/dashboard/passwords", description: "locale-prefixed dashboard" },
    { pathname: "/api", description: "bare /api (no trailing slash) — not API root" },
    { pathname: "/apixyz/foo", description: "non-API prefix-collision" },
  ],
};

describe("classifyRoute — type-driven exhaustiveness over RoutePolicyKind", () => {
  for (const [kind, cases] of Object.entries(POSITIVE_CASES) as [
    RoutePolicyKind,
    readonly ClassifyCase[],
  ][]) {
    if (cases.length === 0) {
      it(`${kind}: skipped — kind exists for orchestrator dispatch but classifier never returns it`, () => {
        expect(kind).toBe(ROUTE_POLICY_KIND.PREFLIGHT);
      });
      continue;
    }
    for (const tc of cases) {
      it(`classifies "${tc.pathname}" (${tc.description}) as ${kind}`, () => {
        expect(classifyRoute(tc.pathname).kind).toBe(kind);
      });
    }
  }
});

describe("classifyRoute — PUBLIC_SHARE adversarial inputs (deny path dominant)", () => {
  // Every one of these must NOT classify as PUBLIC_SHARE — they don't match the
  // exact regex `^/api/share-links/[^/]+/content$`. Anything else is leak.
  const NEGATIVE: readonly ClassifyCase[] = [
    { pathname: "/api/share-links/foo/bar/content", description: "two id segments" },
    { pathname: "/api/share-links//content", description: "empty id" },
    { pathname: "/api/share-links/foo/content/extra", description: "trailing extra segment" },
    {
      pathname: "/api/share-links/foo/content?qs=1",
      description: "query string in pathname (regex tests pathname-only)",
    },
    { pathname: "/api/share-links/../share-links/foo/content", description: "dot-dot traversal" },
    {
      pathname: `/api/share-links/foo/content${String.fromCharCode(0)}`,
      description: "NUL byte trailing",
    },
  ];

  for (const tc of NEGATIVE) {
    it(`does NOT classify "${tc.description}" as PUBLIC_SHARE`, () => {
      expect(classifyRoute(tc.pathname).kind).not.toBe(ROUTE_POLICY_KIND.PUBLIC_SHARE);
    });
  }

  it("treats /api/share-links/foo%2Fbar/content as a single segment (matches PUBLIC_SHARE)", () => {
    // The regex sees `[^/]+` and the encoded slash is literal — it IS a single
    // segment from the regex's perspective. This documents the current shape;
    // if the orchestrator decides to URL-decode before classification, this
    // test will fail and force a deliberate spec change.
    expect(classifyRoute("/api/share-links/foo%2Fbar/content").kind).toBe(
      ROUTE_POLICY_KIND.PUBLIC_SHARE,
    );
  });

  it("treats NUL byte inside id segment as part of the id (regex char-class allows NUL)", () => {
    // The regex `[^/]+` only excludes `/`; NUL passes. Documenting current
    // shape — if classifier decides to whitelist printable chars instead, this
    // test will need updating with a deliberate spec change.
    const path = `/api/share-links/foo${String.fromCharCode(0)}/content`;
    expect(classifyRoute(path).kind).toBe(ROUTE_POLICY_KIND.PUBLIC_SHARE);
  });
});

describe("classifyRoute — API_V1 trailing-slash requirement", () => {
  it("classifies /api/v1 (no trailing slash) as API_DEFAULT, not API_V1", () => {
    expect(classifyRoute("/api/v1").kind).toBe(ROUTE_POLICY_KIND.API_DEFAULT);
  });

  it("classifies /api/v1/ (trailing slash, empty path) as API_V1", () => {
    expect(classifyRoute("/api/v1/").kind).toBe(ROUTE_POLICY_KIND.API_V1);
  });

  it("classifies /api/v1xyz as API_DEFAULT (prefix-collision guard)", () => {
    expect(classifyRoute("/api/v1xyz").kind).toBe(ROUTE_POLICY_KIND.API_DEFAULT);
  });
});

describe("classifyRoute — exchange route exact match", () => {
  it("classifies /api/extension/token/exchange exactly as API_EXTENSION_EXCHANGE", () => {
    expect(classifyRoute("/api/extension/token/exchange").kind).toBe(
      ROUTE_POLICY_KIND.API_EXTENSION_EXCHANGE,
    );
  });

  it("classifies /api/extension/token/exchange/extra as API_SESSION_REQUIRED (not exchange)", () => {
    expect(classifyRoute("/api/extension/token/exchange/extra").kind).toBe(
      ROUTE_POLICY_KIND.API_SESSION_REQUIRED,
    );
  });
});

describe("isApiRoute", () => {
  it("returns true for /api/* paths", () => {
    expect(isApiRoute("/api/foo")).toBe(true);
    expect(isApiRoute("/api/passwords/123")).toBe(true);
  });

  it("returns false for bare /api (no trailing slash)", () => {
    expect(isApiRoute("/api")).toBe(false);
  });

  it("returns false for non-API paths", () => {
    expect(isApiRoute("/")).toBe(false);
    expect(isApiRoute("/dashboard")).toBe(false);
    expect(isApiRoute("/apixyz")).toBe(false);
  });
});
