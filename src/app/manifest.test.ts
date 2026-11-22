/**
 * The web app manifest's URLs must carry the deployment base path, or an
 * installed PWA under a sub-path loads icons and its start page from the
 * origin root.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/url-helpers", () => ({ BASE_PATH: "/vault" }));

import manifest from "@/app/manifest";

describe("manifest", () => {
  it("prefixes every icon with the base path", () => {
    expect(manifest().icons).toEqual([
      { src: "/vault/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/vault/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/vault/icon.svg", sizes: "any", type: "image/svg+xml" },
    ]);
  });

  it("scopes the start URL and scope to the base path", () => {
    const m = manifest();

    expect(m.start_url).toBe("/vault/");
    expect(m.scope).toBe("/vault/");
  });

  it("declares a standalone app with the brand name and colors", () => {
    expect(manifest()).toMatchObject({
      name: "passwd-sso",
      short_name: "passwd-sso",
      theme_color: "#5B57D6",
      background_color: "#ffffff",
      display: "standalone",
    });
  });
});
