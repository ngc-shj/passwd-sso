import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exposedPromptResources, resourceCovers } from "../../scripts/lib/war-resource.mjs";
import { HTTP_AUTH_PROMPT_PAGE } from "../lib/constants";
import { PROMPT_PAGE } from "../background/http-auth-prompt";

const ROOT = resolve(__dirname, "../..");
const read = (relative: string) => readFileSync(resolve(ROOT, relative), "utf8");

// The auth-prompt page path lives in three places that cannot share one
// import: the SW (opens it), vite.config.ts (builds it) and the hygiene
// script (checks it, plain .mjs). These pin all three to one value.
describe("auth-prompt page path", () => {
  it("the SW opens the shared constant", () => {
    expect(PROMPT_PAGE).toBe(HTTP_AUTH_PROMPT_PAGE);
  });

  it("vite.config.ts builds the shared constant", () => {
    expect(read("vite.config.ts")).toMatch(/authPrompt:\s*HTTP_AUTH_PROMPT_PAGE\b/);
  });

  it("check-dist-hygiene.mjs checks the same path", () => {
    const literal = /const AUTH_PROMPT_RESOURCE = "([^"]+)";/.exec(read("scripts/check-dist-hygiene.mjs"));
    expect(literal?.[1]).toBe(HTTP_AUTH_PROMPT_PAGE);
  });
});

describe("resourceCovers (web_accessible_resources glob)", () => {
  const PAGE = "src/auth-prompt/index.html";
  it.each([
    ["the exact path", PAGE, true],
    ["a leading slash", `/${PAGE}`, true],
    ["*", "*", true],
    ["a directory wildcard", "src/*", true],
    ["a rooted directory wildcard", "/src/*", true],
    ["an extension wildcard", "*.html", true],
    ["a middle wildcard", "src/*/index.html", true],
    ["another directory", "assets/*", false],
    ["another file", "src/content/token-bridge.js", false],
    ["a prefix only", "src/auth-prompt", false],
    ["regex metacharacters are literal", "src/auth-prompt/index.htm.", false],
  ])("%s", (_name, resource, expected) => {
    expect(resourceCovers(resource, PAGE)).toBe(expected);
  });
});

describe("exposedPromptResources (built manifest fixtures)", () => {
  const manifest = (...resources: string[][]) => ({
    web_accessible_resources: resources.map((r) => ({ resources: r, matches: ["https://*/*"] })),
  });
  const PAGE = HTTP_AUTH_PROMPT_PAGE;

  it("finds a directory wildcard that exposes the page", () => {
    expect(exposedPromptResources(manifest(["assets/a.js"], ["src/*"]), PAGE)).toEqual(["src/*"]);
  });

  it("finds a resource naming the page", () => {
    expect(exposedPromptResources(manifest([`/${PAGE}`]), PAGE)).toEqual([`/${PAGE}`]);
  });

  it("finds a chunk named after the page even off its path", () => {
    expect(exposedPromptResources(manifest(["assets/auth-prompt-abc.js"]), PAGE)).toEqual(["assets/auth-prompt-abc.js"]);
  });

  it("control: assets/* and the content scripts expose nothing", () => {
    expect(
      exposedPromptResources(manifest(["assets/*", "src/content/token-bridge.js", "src/content/webauthn-interceptor.js"]), PAGE),
    ).toEqual([]);
  });

  it("control: a manifest without web_accessible_resources exposes nothing", () => {
    expect(exposedPromptResources({}, PAGE)).toEqual([]);
  });
});
