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
