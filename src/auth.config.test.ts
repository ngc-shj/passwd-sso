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
