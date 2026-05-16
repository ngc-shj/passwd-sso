import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

  // sameSite=strict is the explicit policy choice — guards against silent
  // regression to `lax` (which would re-open the login-CSRF window).
  it("sets sameSite=strict on the session cookie", async () => {
    const config = (await import("@/auth.config")).default;
    expect(config.cookies?.sessionToken?.options?.sameSite).toBe("strict");
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
