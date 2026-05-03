// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import {
  createMockRouter,
  mockI18nNavigation,
  mockNextNavigation,
  mockTeamMismatch,
} from "./mock-app-navigation";

describe("createMockRouter", () => {
  it("returns spies for all router methods", () => {
    const router = createMockRouter();

    router.push("/x");
    router.replace("/y");
    router.back();

    expect(router.push).toHaveBeenCalledWith("/x");
    expect(router.replace).toHaveBeenCalledWith("/y");
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("merges in overrides", () => {
    const customPush = (() => "custom") as unknown as ReturnType<
      typeof createMockRouter
    >["push"];
    const router = createMockRouter({ push: customPush });
    expect(router.push).toBe(customPush);
  });
});

describe("mockNextNavigation", () => {
  it("provides useRouter / useSearchParams / usePathname", () => {
    const mod = mockNextNavigation({ pathname: "/dashboard" });

    const router = mod.useRouter();
    router.push("/dashboard/team");

    expect(router.push).toHaveBeenCalledWith("/dashboard/team");
    expect(mod.usePathname()).toBe("/dashboard");
    expect(mod.useSearchParams() instanceof URLSearchParams).toBe(true);
  });

  it("normalizes string searchParams", () => {
    const mod = mockNextNavigation({ searchParams: "q=hello&page=2" });
    const sp = mod.useSearchParams();
    expect(sp.get("q")).toBe("hello");
    expect(sp.get("page")).toBe("2");
  });

  it("normalizes object searchParams", () => {
    const mod = mockNextNavigation({ searchParams: { tag: "work" } });
    expect(mod.useSearchParams().get("tag")).toBe("work");
  });

  it("defaults pathname to /", () => {
    expect(mockNextNavigation().usePathname()).toBe("/");
  });
});

describe("mockI18nNavigation", () => {
  it("provides useRouter / usePathname / Link / redirect / getPathname", () => {
    const mod = mockI18nNavigation({ pathname: "/ja/dashboard" });

    expect(mod.usePathname()).toBe("/ja/dashboard");
    expect(typeof mod.useRouter().push).toBe("function");
    expect(typeof mod.Link).toBe("function");
    expect(typeof mod.redirect).toBe("function");
    expect(mod.getPathname({ href: "/x" })).toBe("/x");
  });

  it("default Link renders as an accessible <a> with href + children", () => {
    const mod = mockI18nNavigation();
    render(mod.Link({ href: "/teams", children: "Teams" }));
    const link = screen.getByRole("link", { name: "Teams" });
    expect(link).toHaveAttribute("href", "/teams");
  });

  it("merges router method overrides", () => {
    const mod = mockI18nNavigation();
    const router = mod.useRouter();
    router.push("/x");
    expect(router.push).toHaveBeenCalledWith("/x");
  });
});

describe("mockTeamMismatch", () => {
  it("returns useTeamVault with actor's currentTeamId not equal to resource teamId", () => {
    const mod = mockTeamMismatch({
      actorTeamId: "team-a",
      resourceTeamId: "team-b",
    });
    const vault = mod.useTeamVault();
    expect(vault.currentTeamId).toBe("team-a");
    expect(mod.teamId).toBe("team-b");
    expect(vault.currentTeamId).not.toBe(mod.teamId);
    expect(vault.isUnlocked).toBe(false);
    expect(vault.teamKey).toBeNull();
  });
});
