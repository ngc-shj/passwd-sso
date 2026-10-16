import { describe, it, expect } from "vitest";
// defineManifest is the identity, so the default export is the manifest object.
import manifest from "../../manifest.config";

// C1 (issue #905): HTTP auth must stay optional. A required webRequest would
// change the install and update prompts for every user, so the required set and
// the content-script / web-accessible scopes are pinned exactly.
describe("manifest", () => {
  const m = manifest as unknown as {
    permissions: string[];
    optional_permissions?: string[];
    optional_host_permissions?: string[];
    minimum_chrome_version?: string;
    content_scripts: Array<{ matches: string[] }>;
    web_accessible_resources: Array<{ resources: string[]; matches: string[] }>;
  };

  it("keeps the required permissions exactly as they were", () => {
    expect(m.permissions).toEqual([
      "storage", "alarms", "activeTab", "scripting", "contextMenus", "clipboardWrite", "offscreen",
    ]);
  });

  it("asks for the HTTP auth API permissions only as optional ones", () => {
    expect(m.optional_permissions).toEqual(["webRequest", "webRequestAuthProvider"]);
  });

  it("adds http://*/* to the optional host permissions", () => {
    expect(m.optional_host_permissions).toEqual(["https://*/*", "http://localhost/*", "http://*/*"]);
  });

  it("sets the Chrome floor asyncBlocking onAuthRequired needs in MV3", () => {
    expect(m.minimum_chrome_version).toBe("120");
  });

  it("leaves the content-script matches unchanged", () => {
    expect(m.content_scripts.map((c) => c.matches)).toEqual([["https://*/*", "http://localhost/*"]]);
  });

  it("leaves the web-accessible resources unchanged", () => {
    expect(m.web_accessible_resources).toEqual([
      {
        resources: ["src/content/token-bridge.js", "src/content/webauthn-interceptor.js"],
        matches: ["https://*/*", "http://localhost/*"],
      },
    ]);
  });

  it("never makes the auth-prompt page web-accessible", () => {
    const resources = m.web_accessible_resources.flatMap((r) => r.resources);
    expect(resources.some((r) => r.includes("auth-prompt"))).toBe(false);
    expect(resources.some((r) => r.includes("*"))).toBe(false);
  });
});
