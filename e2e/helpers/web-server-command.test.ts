/**
 * Which server the E2E suite boots, per `resolveWebServerCommand`.
 *
 * The regression this exists to catch has no other symptom: if the local
 * production opt-in had REPLACED the `CI` condition instead of being added to
 * it, every existing spec would have moved onto `next dev` in CI — where they
 * have always run against a production build — and the whole suite would have
 * stayed green while measuring a different subject.
 */
import { describe, it, expect } from "vitest";
import {
  resolveWebServerCommand,
  PROD_WEB_SERVER_COMMAND,
  DEV_WEB_SERVER_COMMAND,
} from "./web-server-command";

describe("resolveWebServerCommand", () => {
  it("serves a production build on CI, with no flag set", () => {
    expect(resolveWebServerCommand({ CI: "true" })).toBe(PROD_WEB_SERVER_COMMAND);
  });

  it("serves a production build locally when E2E_CSP_SERVER=prod", () => {
    expect(resolveWebServerCommand({ E2E_CSP_SERVER: "prod" })).toBe(
      PROD_WEB_SERVER_COMMAND,
    );
  });

  // The case that makes the other two non-trivial: a resolver that always
  // returned the production command would satisfy both without it.
  it("serves the dev server locally when neither is set", () => {
    expect(resolveWebServerCommand({})).toBe(DEV_WEB_SERVER_COMMAND);
  });

  // The regression the additive form prevents. A replacement would red here
  // and nowhere else.
  it("keeps the production build on CI when the flag is absent", () => {
    expect(resolveWebServerCommand({ CI: "1" })).toBe(PROD_WEB_SERVER_COMMAND);
  });

  // Only the exact opt-in value counts, so an unrelated value cannot silently
  // move a local run onto a slow production build.
  it("ignores an E2E_CSP_SERVER value other than 'prod'", () => {
    expect(resolveWebServerCommand({ E2E_CSP_SERVER: "dev" })).toBe(
      DEV_WEB_SERVER_COMMAND,
    );
  });
});
