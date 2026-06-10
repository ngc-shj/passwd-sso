import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SEC_PER_MINUTE, MS_PER_MINUTE } from "@/lib/constants/time";

describe("auth.config basePath handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pages use basePath prefix when NEXT_PUBLIC_BASE_PATH is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const config = (await import("@/auth.config")).default;

    expect(config.pages?.signIn).toBe("/passwd-sso/auth/signin");
    expect(config.pages?.error).toBe("/passwd-sso/auth/error");
  });

  it("pages have no prefix when NEXT_PUBLIC_BASE_PATH is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const config = (await import("@/auth.config")).default;

    expect(config.pages?.signIn).toBe("/auth/signin");
    expect(config.pages?.error).toBe("/auth/error");
  });

  it("cookie path includes basePath when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const config = (await import("@/auth.config")).default;

    expect(config.cookies?.sessionToken?.options?.path).toBe("/passwd-sso/");
  });

  it("cookie path is / when NEXT_PUBLIC_BASE_PATH is empty", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const config = (await import("@/auth.config")).default;

    expect(config.cookies?.sessionToken?.options?.path).toBe("/");
  });

  it("strips trailing slash from basePath in pages", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso/");
    const config = (await import("@/auth.config")).default;

    expect(config.pages?.signIn).toBe("/passwd-sso/auth/signin");
  });
});

describe("auth.config session cookie attributes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // sameSite=lax is the explicit policy choice — guards against silent
  // regression to `strict` (which would suppress the session cookie on the
  // OAuth callback redirect chain, bouncing users to /auth/signin on
  // first hit after sign-in). Login CSRF is defended by Auth.js's `state`
  // cookie + PKCE on OAuth and by the proxy CSRF gate on POST/PUT/PATCH/DELETE.
  it("sets sameSite=lax on the session cookie", async () => {
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.options?.sameSite).toBe("lax");
  });

  it("sets httpOnly=true on the session cookie", async () => {
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.options?.httpOnly).toBe(true);
  });

  // Matrix: AUTH_URL × NEXT_PUBLIC_BASE_PATH drives the cookie name.
  // A regression that inlines the prefix-selection in auth.config.ts
  // would trip whichever quadrant got missed.
  it("uses __Host- when AUTH_URL is https AND basePath is empty", async () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.name).toBe("__Host-authjs.session-token");
  });

  it("uses __Secure- when AUTH_URL is https AND basePath is set", async () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/vault");
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.name).toBe("__Secure-authjs.session-token");
  });

  it("uses plain name when AUTH_URL is http (any basePath)", async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.name).toBe("authjs.session-token");
  });

  it("uses plain name when AUTH_URL is http even with basePath", async () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/vault");
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.name).toBe("authjs.session-token");
  });

  // __Host- spec requires Path=/ — verify the coupling holds whenever
  // the __Host- name is selected.
  it("when __Host- name is selected, the cookie path is exactly '/'", async () => {
    vi.stubEnv("AUTH_URL", "https://example.com");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.name).toBe("__Host-authjs.session-token");
    expect(config.cookies?.sessionToken?.options?.path).toBe("/");
  });
});

describe("auth.config Google domain validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function getSignIn() {
    const config = (await import("@/auth.config")).default;
    return config.callbacks!.signIn! as (params: {
      account: { provider: string } | null;
      profile: Record<string, unknown>;
    }) => Promise<boolean>;
  }

  it("allows any Google account when GOOGLE_WORKSPACE_DOMAINS is unset", async () => {
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "google" },
        profile: { hd: "random.com" },
      }),
    ).toBe(true);

    expect(
      await signIn({
        account: { provider: "google" },
        profile: {},
      }),
    ).toBe(true);
  });

  it("allows matching domain for single domain config", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", "example.com");
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "google" },
        profile: { hd: "example.com" },
      }),
    ).toBe(true);
  });

  it("rejects non-matching domain for single domain config", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", "example.com");
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "google" },
        profile: { hd: "other.com" },
      }),
    ).toBe(false);
  });

  it("rejects personal Gmail (no hd) when domain is configured", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", "example.com");
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "google" },
        profile: {},
      }),
    ).toBe(false);
  });

  it("allows matching domain from multi-domain config", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", "example.com,example.co.jp");
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "google" },
        profile: { hd: "example.co.jp" },
      }),
    ).toBe(true);
  });

  it("rejects non-matching domain from multi-domain config", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", "example.com,example.co.jp");
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "google" },
        profile: { hd: "other.com" },
      }),
    ).toBe(false);
  });

  it("performs case-insensitive domain comparison", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", "Example.COM");
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "google" },
        profile: { hd: "example.com" },
      }),
    ).toBe(true);
  });

  it("allows non-Google providers regardless of domain config", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DOMAINS", "example.com");
    const signIn = await getSignIn();

    expect(
      await signIn({
        account: { provider: "saml-jackson" },
        profile: {},
      }),
    ).toBe(true);
  });
});

describe("auth.config rate limiter: magic-link failClosedOnRedisError", () => {
  // T1: verify that createRateLimiter is called with failClosedOnRedisError: true
  // for the magic-link limiter (windowMs 10*MS_PER_MINUTE, max 3).
  const { mockCreateRateLimiter } = vi.hoisted(() => ({
    mockCreateRateLimiter: vi.fn(() => ({ check: vi.fn(), clear: vi.fn() })),
  }));

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.mock("@/lib/security/rate-limit", () => ({
      createRateLimiter: mockCreateRateLimiter,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("T1: magic-link limiter is created with failClosedOnRedisError:true", async () => {
    await import("@/auth.config");

    const magicLinkCall = mockCreateRateLimiter.mock.calls.find(
      ([opts]) =>
        opts.windowMs === 10 * MS_PER_MINUTE && opts.max === 3,
    );
    expect(magicLinkCall).toBeDefined();
    expect(magicLinkCall![0]).toMatchObject({ failClosedOnRedisError: true });
  });
});

describe("auth.config magic-link provider settings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Nodemailer provider maxAge equals 15 * SEC_PER_MINUTE", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "nodemailer");
    // vi.resetModules() is called in beforeEach — fresh import picks up the stub
    const config = (await import("@/auth.config")).default;
    const nodemailerProvider = config.providers.find(
      (p): p is { id: string; maxAge?: number } =>
        typeof p === "object" && p !== null && "id" in p && (p as { id: string }).id === "nodemailer",
    );

    expect(nodemailerProvider).toBeDefined();
    // maxAge is seconds; 15 * SEC_PER_MINUTE = 15 * 60 = 900
    expect(nodemailerProvider?.maxAge).toBe(15 * SEC_PER_MINUTE);
  });

  it("MAGIC_LINK_TTL_MINUTES is 15 (equals 15 * SEC_PER_MINUTE / SEC_PER_MINUTE)", async () => {
    const { MAGIC_LINK_TTL_MINUTES } = await import("@/lib/constants/auth/magic-link");
    // This constant is the single source of truth shared by the provider and the email template
    expect(MAGIC_LINK_TTL_MINUTES).toBe(15);
  });
});
